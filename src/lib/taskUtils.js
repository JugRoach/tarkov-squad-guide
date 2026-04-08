import { getObjMeta, progressKey, getAllPrereqTaskIds } from './utils.js';

export function markTaskCompleteInProgress(profileId, taskId, apiTask, progress) {
  const p = { ...progress };
  (apiTask.objectives || []).forEach(obj => {
    if (obj.optional) return;
    const k = `${profileId}-${taskId}-${obj.id}`;
    const meta = getObjMeta(obj);
    p[k] = meta.total;
  });
  return p;
}

export function cleanOrphanedPrereqProgress(profileId, taskList, apiTasks, progress) {
  const taskIds = new Set(taskList.map(t => t.taskId));
  const neededPrereqs = new Set();
  taskList.forEach(({ taskId }) => {
    getAllPrereqTaskIds(taskId, apiTasks).forEach(id => neededPrereqs.add(id));
  });
  const p = {};
  const prefix = profileId + "-";
  for (const [key, val] of Object.entries(progress)) {
    if (!key.startsWith(prefix)) { p[key] = val; continue; }
    const rest = key.slice(prefix.length);
    const lastDash = rest.lastIndexOf("-");
    const taskIdInKey = rest.slice(0, lastDash);
    if (taskIds.has(taskIdInKey) || neededPrereqs.has(taskIdInKey)) {
      p[key] = val;
    }
  }
  return p;
}

// ─── AVAILABLE TASKS (unlocked by completed prerequisites) ───
export function getAvailableTasks(apiTasks, completedIds, failedIds, existingIds, playerLevel) {
  if (!apiTasks?.length) return [];
  return apiTasks.filter(task => {
    // Skip completed, failed, or already-tracked tasks
    if (completedIds.has(task.id) || failedIds.has(task.id) || existingIds.has(task.id)) return false;
    // Check player level requirement
    if (playerLevel && task.minPlayerLevel && task.minPlayerLevel > playerLevel) return false;
    // Check all prerequisites are completed
    const reqs = task.taskRequirements || [];
    return reqs.every(req => {
      if (!req.status?.includes("complete")) return true; // non-"complete" status reqs don't block
      return completedIds.has(req.task?.id);
    });
  });
}

// ─── QUEST TREE DEPTH (topological progression order) ────────
export function computeTaskDepths(apiTasks) {
  if (!apiTasks?.length) return {};
  const depths = {};
  const computing = new Set();
  const getDepth = (taskId) => {
    if (depths[taskId] !== undefined) return depths[taskId];
    if (computing.has(taskId)) return 0;
    computing.add(taskId);
    const task = apiTasks.find(t => t.id === taskId);
    if (!task?.taskRequirements?.length) { depths[taskId] = 0; computing.delete(taskId); return 0; }
    let maxParentDepth = -1;
    for (const req of task.taskRequirements) {
      if (req.status?.includes("complete") && req.task?.id) {
        maxParentDepth = Math.max(maxParentDepth, getDepth(req.task.id));
      }
    }
    depths[taskId] = maxParentDepth < 0 ? 0 : maxParentDepth + 1;
    computing.delete(taskId);
    return depths[taskId];
  };
  apiTasks.forEach(t => getDepth(t.id));
  return depths;
}
