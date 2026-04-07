// Core utility functions extracted for testability.
// TarkovGuide.jsx still has its own inline copies — these are the canonical versions
// that tests run against. A future refactor should import from here.

export function worldToPct(pos, bounds) {
  if (!pos || !bounds) return null;
  const { left, right, top, bottom } = bounds;
  const gx = bounds.swap ? pos.z : pos.x;
  const gz = bounds.swap ? pos.x : pos.z;
  const x = (gx - left) / (right - left);
  const y = (gz - top) / (bottom - top);
  if (isNaN(x) || isNaN(y)) return null;
  if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return null;
  return { x: Math.max(0.02, Math.min(0.98, x)), y: Math.max(0.02, Math.min(0.98, y)) };
}

export function nearestNeighbor(waypoints) {
  if (!waypoints.length) return [];
  const remaining = [...waypoints];
  const route = [];
  const first = remaining.reduce((best, w, i) => w.pct ? (!best.w || i === 0 ? { w, i } : best) : best, { w: null, i: 0 });
  const start = remaining.splice(first.i, 1)[0];
  route.push(start);
  let cur = start.pct ? { pct: start.pct } : { pct: { x: 0, y: 0 } };
  while (remaining.length) {
    const hasPos = remaining.some(w => w.pct);
    if (!hasPos) { route.push(...remaining); break; }
    let best = 0, bestD = Infinity;
    remaining.forEach((w, i) => {
      if (!w.pct) return;
      const d = Math.hypot(w.pct.x - cur.pct.x, w.pct.y - cur.pct.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    const next = remaining.splice(best, 1)[0];
    route.push(next);
    if (next.pct) cur = { pct: next.pct };
  }
  return route;
}

export function getObjMeta(obj) {
  const t = obj.type;
  if (t === "shoot") return { icon: "☠", color: "#e05a5a", summary: `Kill ${obj.count > 1 ? obj.count + "× " : ""}${obj.targetNames?.[0] || "enemy"}${obj.zoneNames?.length ? " (" + obj.zoneNames[0] + ")" : ""}`, isCountable: true, total: obj.count || 1 };
  if (t === "findItem" || t === "giveItem" || t === "sellItem") return { icon: "◈", color: "#d4b84a", summary: `${obj.count > 1 ? obj.count + "× " : ""}${obj.items?.[0]?.name || "item"}${obj.foundInRaid ? " (FIR)" : ""}`, isCountable: obj.count > 1, total: obj.count || 1 };
  if (t === "visit") return { icon: "◉", color: "#9a7aba", summary: obj.description, isCountable: false, total: 1 };
  if (t === "extract") return { icon: "⬆", color: "#5dba5d", summary: obj.exitName ? `Extract via ${obj.exitName}` : "Extract from map", isCountable: false, total: 1 };
  return { icon: "♦", color: "#7a9a7a", summary: obj.description || t, isCountable: false, total: 1 };
}

export function progressKey(profileId, taskId, objId) {
  return `${profileId}-${taskId}-${objId}`;
}

export function isTaskComplete(profileId, taskId, apiTask, progress) {
  const reqObjs = (apiTask?.objectives || []).filter(o => !o.optional);
  if (!reqObjs.length) return false;
  return reqObjs.every(obj => ((progress || {})[progressKey(profileId, taskId, obj.id)] || 0) >= getObjMeta(obj).total);
}

const CODE_VERSION = "TG2";
const PLAYER_COLORS = ["#c8a84b", "#5a9aba", "#9a5aba", "#5aba8a", "#ba7a5a"];

export function encodeProfile(p) {
  try {
    return CODE_VERSION + ":" + btoa(unescape(encodeURIComponent(JSON.stringify({
      v: 2, n: p.name, c: p.color, t: p.tasks || [], pr: p.progress || {}
    }))));
  } catch { return null; }
}

export function decodeProfile(code) {
  try {
    if (!code || code.length > 50000) return null;
    const b64 = code.trim().startsWith(CODE_VERSION + ":") ? code.trim().slice(CODE_VERSION.length + 1) : code.trim();
    const d = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (!d.n || typeof d.n !== "string") return null;
    return {
      id: "imp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
      name: d.n.slice(0, 30),
      color: d.c || PLAYER_COLORS[0],
      tasks: Array.isArray(d.t) ? d.t : [],
      progress: d.pr && typeof d.pr === "object" ? d.pr : {},
      imported: true,
      importedAt: Date.now(),
    };
  } catch { return null; }
}

export function getAllPrereqTaskIds(taskId, apiTasks, visited = new Set()) {
  if (visited.has(taskId)) return [];
  visited.add(taskId);
  const task = apiTasks?.find(t => t.id === taskId);
  if (!task?.taskRequirements?.length) return [];
  const prereqIds = [];
  for (const req of task.taskRequirements) {
    if (req.status?.includes("complete") && req.task?.id) {
      prereqIds.push(req.task.id);
      prereqIds.push(...getAllPrereqTaskIds(req.task.id, apiTasks, visited));
    }
  }
  return prereqIds;
}
