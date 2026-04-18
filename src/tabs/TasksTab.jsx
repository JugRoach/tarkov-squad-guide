import { useState, useRef, useMemo, useCallback } from "react";
import { T } from '../theme.js';
import { SL, Badge, Btn, Tip } from '../components/ui/index.js';
import { getObjMeta, progressKey, getAllPrereqTaskIds } from '../lib/utils.js';
import { markTaskCompleteInProgress, cleanOrphanedPrereqProgress, computeTaskDepths, getAvailableTasks } from '../lib/taskUtils.js';
import { traderSort } from '../constants.js';
import { useStorage } from '../hooks/useStorage.js';

export default function TasksTab({ myProfile, saveMyProfile, apiTasks, apiTraders, loading, apiError, apiHideout, hideoutLevels, saveHideoutLevels, hideoutTarget, saveHideoutTarget, onRouteTask }) {
  const [profileSub, setProfileSub] = useState("tasks"); // "tasks" | "browse" | "hideout" | "chains"
  const [chainTrader, setChainTrader] = useState("all");
  const [expandedChainNodes, setExpandedChainNodes] = useState(new Set());
  const [taskSearch, setTaskSearch] = useState("");
  const taskSearchDebounce = useRef(null);
  const [taskSearchDeferred, setTaskSearchDeferred] = useState("");
  const [taskTrader, setTaskTrader] = useState("all");
  const [taskMapFilter, setTaskMapFilter] = useState("all");
  const [expandedTask, setExpandedTask] = useState(null);
  const [taskGroupBy, setTaskGroupBy] = useState("trader"); // "az", "trader", "map"
  const [hideoutPrereq, setHideoutPrereq] = useState(null);
  const [expandedStation, setExpandedStation] = useState(null);

  // TarkovTracker sync
  const [ttToken, saveTtToken] = useStorage("tg-tarkovtracker-token-v1", "");
  const [ttTokenInput, setTtTokenInput] = useState("");
  const [ttSyncStatus, setTtSyncStatus] = useState("idle"); // idle | syncing | done | error
  const [ttSyncMsg, setTtSyncMsg] = useState("");
  const [ttExpanded, setTtExpanded] = useState(false);

  const syncFromTarkovTracker = useCallback(async () => {
    const token = ttToken || ttTokenInput.trim();
    if (!token) { setTtSyncMsg("Enter your TarkovTracker API token first."); setTtSyncStatus("error"); return; }
    setTtSyncStatus("syncing"); setTtSyncMsg("");
    try {
      const res = await fetch("https://tarkovtracker.io/api/v2/progress", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(res.status === 401 ? "Invalid token — check your TarkovTracker API key." : `TarkovTracker returned ${res.status}`);
      const { data } = await res.json();
      if (!data?.tasksProgress) throw new Error("Unexpected response format.");

      // Save token on success if not already saved
      if (!ttToken && ttTokenInput.trim()) saveTtToken(ttTokenInput.trim());

      const completedIds = new Set(data.tasksProgress.filter(t => t.complete && !t.invalid).map(t => t.id));
      const failedIds = new Set(data.tasksProgress.filter(t => t.failed && !t.invalid).map(t => t.id));
      const startedIds = new Set(data.tasksProgress.filter(t => !t.complete && !t.failed && !t.invalid).map(t => t.id));

      // Build objective progress map from TarkovTracker
      const objProgressMap = {};
      (data.taskObjectivesProgress || []).forEach(o => {
        if (!o.invalid) objProgressMap[o.id] = { complete: o.complete, count: o.count || 0 };
      });

      // Merge into profile
      const existing = myProfile.tasks || [];
      const existingIds = new Set(existing.map(t => t.taskId));
      let newTasks = [...existing];
      let newProgress = { ...(myProfile.progress || {}) };
      let added = 0, progressUpdated = 0;

      // Add started (incomplete) tasks that aren't already in list
      startedIds.forEach(taskId => {
        if (!existingIds.has(taskId) && !completedIds.has(taskId)) {
          const apiTask = apiTasks?.find(t => t.id === taskId);
          if (apiTask) { newTasks.push({ taskId }); added++; }
        }
      });

      // Mark completed tasks' objectives as done in progress
      completedIds.forEach(taskId => {
        const apiTask = apiTasks?.find(t => t.id === taskId);
        if (!apiTask) return;
        if (!existingIds.has(taskId)) { newTasks.push({ taskId }); added++; }
        (apiTask.objectives || []).filter(o => !o.optional).forEach(obj => {
          const key = progressKey(myProfile.id, taskId, obj.id);
          const meta = getObjMeta(obj);
          if ((newProgress[key] || 0) < meta.total) { newProgress[key] = meta.total; progressUpdated++; }
        });
      });

      // Import partial objective progress for started tasks
      startedIds.forEach(taskId => {
        const apiTask = apiTasks?.find(t => t.id === taskId);
        if (!apiTask) return;
        (apiTask.objectives || []).filter(o => !o.optional).forEach(obj => {
          const ttObj = objProgressMap[obj.id];
          if (!ttObj) return;
          const key = progressKey(myProfile.id, taskId, obj.id);
          const meta = getObjMeta(obj);
          if (ttObj.complete) {
            if ((newProgress[key] || 0) < meta.total) { newProgress[key] = meta.total; progressUpdated++; }
          } else if (ttObj.count > (newProgress[key] || 0)) {
            newProgress[key] = ttObj.count; progressUpdated++;
          }
        });
      });

      // Auto-add available tasks (all prereqs completed, level met)
      const currentIds = new Set(newTasks.map(t => t.taskId));
      const available = getAvailableTasks(apiTasks, completedIds, failedIds, currentIds, data.playerLevel || 0);
      let autoAdded = 0;
      available.forEach(task => {
        newTasks.push({ taskId: task.id });
        autoAdded++;
        // Mark their prereqs complete in progress
        const prereqIds = [...new Set(getAllPrereqTaskIds(task.id, apiTasks))];
        prereqIds.forEach(prereqId => {
          const prereqTask = apiTasks?.find(t => t.id === prereqId);
          if (prereqTask) newProgress = markTaskCompleteInProgress(myProfile.id, prereqId, prereqTask, newProgress);
        });
      });

      saveMyProfile({ ...myProfile, tasks: newTasks, progress: newProgress });
      const level = data.playerLevel ? ` (Level ${data.playerLevel})` : "";
      const autoMsg = autoAdded > 0 ? ` ${autoAdded} available tasks auto-added.` : "";
      setTtSyncMsg(`Synced${level}: ${added} tasks added, ${progressUpdated} objectives updated. ${completedIds.size} completed, ${startedIds.size} in progress.${autoMsg}`);
      setTtSyncStatus("done");
    } catch (e) {
      setTtSyncMsg(e.message || "Sync failed.");
      setTtSyncStatus("error");
    }
  }, [ttToken, ttTokenInput, apiTasks, myProfile, saveMyProfile, saveTtToken]);

  const traders = useMemo(() => [...new Set((apiTasks || []).map(t => t.trader?.name).filter(Boolean))].sort(traderSort), [apiTasks]);
  const traderImgMap = useMemo(() => Object.fromEntries((apiTraders || []).map(t => [t.name, t.imageLink])), [apiTraders]);
  const taskMaps = useMemo(() => [...new Set((apiTasks || []).map(t => t.map?.name).filter(Boolean))].sort(), [apiTasks]);
  const taskDepths = useMemo(() => computeTaskDepths(apiTasks), [apiTasks]);
  const progressionSort = (a, b) => {
    const da = taskDepths[a.id] ?? 999, db = taskDepths[b.id] ?? 999;
    if (da !== db) return da - db;
    const la = a.minPlayerLevel || 0, lb = b.minPlayerLevel || 0;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  };
  const filteredTasks = useMemo(() => (apiTasks || []).filter(t => {
    if (taskTrader !== "all" && t.trader?.name !== taskTrader) return false;
    if (taskMapFilter !== "all" && t.map?.name !== taskMapFilter) return false;
    if (taskSearch && !t.name.toLowerCase().includes(taskSearchDeferred.toLowerCase())) return false;
    return true;
  }).slice(0, 50), [apiTasks, taskTrader, taskMapFilter, taskSearch, taskSearchDeferred]);

  const addTask = useCallback(taskId => {
    const existing = myProfile.tasks || [];
    if (existing.some(t => t.taskId === taskId)) return;
    const prereqIds = [...new Set(getAllPrereqTaskIds(taskId, apiTasks))];
    const newTasks = [...existing, { taskId }];
    let newProgress = { ...(myProfile.progress || {}) };
    prereqIds.forEach(prereqId => {
      if (existing.some(t => t.taskId === prereqId)) return;
      const prereqTask = apiTasks?.find(t => t.id === prereqId);
      if (prereqTask) newProgress = markTaskCompleteInProgress(myProfile.id, prereqId, prereqTask, newProgress);
    });
    saveMyProfile({ ...myProfile, tasks: newTasks, progress: newProgress });
  }, [myProfile, apiTasks, saveMyProfile]);
  const removeTask = useCallback(taskId => {
    const newTasks = (myProfile.tasks || []).filter(t => t.taskId !== taskId);
    const newProgress = cleanOrphanedPrereqProgress(myProfile.id, newTasks, apiTasks, myProfile.progress || {});
    saveMyProfile({ ...myProfile, tasks: newTasks, progress: newProgress });
  }, [myProfile, apiTasks, saveMyProfile]);

  // Browse tasks data (always computed, used by Browse sub-tab)
  const traderTaskCounts = {};
  traders.forEach(tr => {
    const trTasks = (apiTasks || []).filter(t => t.trader?.name === tr);
    const addedCount = trTasks.filter(t => myProfile.tasks?.some(mt => mt.taskId === t.id)).length;
    traderTaskCounts[tr] = { total: trTasks.length, added: addedCount };
  });
  const browseLimit = taskTrader !== "all" ? 999 : 50;
  const browseTasks = useMemo(() => (apiTasks || []).filter(t => {
    if (taskTrader !== "all" && t.trader?.name !== taskTrader) return false;
    if (taskMapFilter !== "all" && t.map?.name !== taskMapFilter) return false;
    if (taskSearch && !t.name.toLowerCase().includes(taskSearchDeferred.toLowerCase())) return false;
    return true;
  }).sort(progressionSort).slice(0, browseLimit), [apiTasks, taskTrader, taskMapFilter, taskSearch, taskSearchDeferred, taskDepths, browseLimit]);
  const addAllForTrader = (traderName) => {
    const trTasks = (apiTasks || []).filter(t => t.trader?.name === traderName);
    let allTasks = [...(myProfile.tasks || [])];
    let newProgress = { ...(myProfile.progress || {}) };
    trTasks.forEach(task => {
      if (!allTasks.some(t => t.taskId === task.id)) allTasks.push({ taskId: task.id });
      const prereqIds = [...new Set(getAllPrereqTaskIds(task.id, apiTasks))];
      prereqIds.forEach(prereqId => {
        const prereqTask = apiTasks?.find(t => t.id === prereqId);
        if (prereqTask) newProgress = markTaskCompleteInProgress(myProfile.id, prereqId, prereqTask, newProgress);
      });
    });
    saveMyProfile({ ...myProfile, tasks: allTasks, progress: newProgress });
  };
  const removeAllForTrader = (traderName) => {
    const trTaskIds = new Set((apiTasks || []).filter(t => t.trader?.name === traderName).map(t => t.id));
    const newTasks = (myProfile.tasks || []).filter(t => !trTaskIds.has(t.taskId));
    const newProgress = cleanOrphanedPrereqProgress(myProfile.id, newTasks, apiTasks, myProfile.progress || {});
    saveMyProfile({ ...myProfile, tasks: newTasks, progress: newProgress });
  };

  const subTabs = [
    { id: "tasks", label: `My Tasks (${myProfile.tasks?.length || 0})`, icon: "★" },
    { id: "browse", label: "Browse", icon: "+" },
    { id: "chains", label: "Trees", icon: "⛓" },
    { id: "hideout", label: "Hideout", icon: "◈" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        {/* Sub-tabs */}
        <div role="tablist" style={{ display: "flex", gap: 4 }}>
          {subTabs.map(st => (
            <button key={st.id} role="tab" aria-selected={profileSub === st.id} onClick={() => setProfileSub(st.id)} style={{
              flex: 1, padding: "8px 4px", fontSize: T.fs2, letterSpacing: 1, fontFamily: T.sans, textTransform: "uppercase",
              background: profileSub === st.id ? myProfile.color + "22" : "transparent",
              border: `2px solid ${profileSub === st.id ? myProfile.color : T.border}`,
              color: profileSub === st.id ? myProfile.color : T.textDim,
              cursor: "pointer", fontWeight: profileSub === st.id ? "bold" : "normal",
              transition: "background 0.15s, border-color 0.15s",
            }}>{st.icon} {st.label}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* ── BROWSE SUB-TAB ── */}
        {profileSub === "browse" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: T.fs2, color: T.textDim, fontFamily: T.sans }}>{myProfile.tasks?.length || 0} selected</div>
            </div>
            <input aria-label="Search tasks" value={taskSearch} onChange={e => { setTaskSearch(e.target.value); clearTimeout(taskSearchDebounce.current); taskSearchDebounce.current = setTimeout(() => setTaskSearchDeferred(e.target.value), 200); }} placeholder="Search tasks..." style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "7px 10px", fontSize: T.fs2, fontFamily: T.sans, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1.5, marginBottom: 6, fontFamily: T.sans }}>TRADERS<Tip text="Tap a trader to see their tasks. Use 'ADD ALL' to grab every task from that trader, or add them one by one." /></div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <button onClick={() => setTaskTrader("all")} style={{
                display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans,
                background: taskTrader === "all" ? T.gold + "22" : "transparent",
                border: `2px solid ${taskTrader === "all" ? T.gold : T.border}`,
                color: taskTrader === "all" ? T.gold : T.textDim, cursor: "pointer",
              }}>All</button>
              {traders.map(tr => {
                const counts = traderTaskCounts[tr] || { total: 0, added: 0 };
                const allAdded = counts.added === counts.total && counts.total > 0;
                const isActive = taskTrader === tr;
                const clr = allAdded ? T.success : T.gold;
                return (
                  <button key={tr} onClick={() => setTaskTrader(tr)} style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", fontSize: T.fs2, fontFamily: T.sans,
                    background: isActive ? clr + "22" : "transparent",
                    border: `2px solid ${isActive ? clr : T.border}`,
                    color: isActive ? clr : T.textDim, cursor: "pointer",
                  }}>
                    {traderImgMap[tr] && <img src={traderImgMap[tr]} alt={tr} style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover" }} />}
                    <span>{tr} ({counts.added}/{counts.total})</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
              <Btn ch="All Maps" compact active={taskMapFilter === "all"} onClick={() => setTaskMapFilter("all")} />
              {taskMaps.map(m => <Btn key={m} ch={m.split(" ")[0]} compact active={taskMapFilter === m} onClick={() => setTaskMapFilter(m)} />)}
            </div>
            {loading && <div style={{ color: T.textDim, fontSize: T.fs4, textAlign: "center", padding: 20 }}>Loading live data from tarkov.dev...</div>}
            {apiError && <div style={{ color: T.error, fontSize: T.fs4, textAlign: "center", padding: 20 }}>Could not reach tarkov.dev. Check connection.</div>}
            {taskTrader !== "all" && (
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {(traderTaskCounts[taskTrader]?.added || 0) < (traderTaskCounts[taskTrader]?.total || 0) && (
                  <button onClick={() => addAllForTrader(taskTrader)} style={{ flex: 1, background: myProfile.color + "22", border: `2px solid ${myProfile.color}`, color: myProfile.color, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>+ ADD ALL {taskTrader.toUpperCase()}</button>
                )}
                {(traderTaskCounts[taskTrader]?.added || 0) > 0 && (
                  <button onClick={() => removeAllForTrader(taskTrader)} style={{ flex: 1, background: T.errorBg, border: `2px solid ${T.errorBorder}`, color: T.error, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>✕ REMOVE ALL</button>
                )}
              </div>
            )}
            <div style={{ fontSize: T.fs3, color: T.textDim, letterSpacing: 1, marginBottom: 10 }}>{browseTasks.length} TASKS{taskTrader !== "all" ? ` · ${taskTrader.toUpperCase()}` : " · LIVE FROM TARKOV.DEV"}<Tip text="Tap the ↗ icon next to any task name to open its wiki page for detailed walkthroughs and tips." /></div>
            {(() => {
              const myPrereqIds = new Set();
              (myProfile.tasks || []).forEach(({ taskId }) => { getAllPrereqTaskIds(taskId, apiTasks).forEach(id => myPrereqIds.add(id)); });
              const unlocksMap = {};
              (apiTasks || []).forEach(t => {
                (t.taskRequirements || []).forEach(req => {
                  if (req.status?.includes("complete") && req.task?.id) {
                    unlocksMap[req.task.id] = (unlocksMap[req.task.id] || 0) + 1;
                  }
                });
              });
              const completedFromLogsSet = new Set(myProfile.completedTasks || []);
              return browseTasks.map(task => {
                const added = myProfile.tasks?.some(t => t.taskId === task.id);
                const prereqDone = !added && myPrereqIds.has(task.id);
                const autoCompleted = completedFromLogsSet.has(task.id);
                const prog = myProfile.progress || {};
                const reqObjs = (task.objectives || []).filter(o => !o.optional);
                const browseComplete = autoCompleted || (added && reqObjs.length > 0 && reqObjs.every(obj => { const k = `${myProfile.id}-${task.id}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }));
                const cardBg = browseComplete ? T.successBg : prereqDone ? T.successBg : T.surface;
                const cardBorder = browseComplete ? T.successBorder : added ? myProfile.color : prereqDone ? T.successBorder : T.border;
                const cardLeft = browseComplete ? T.success : added ? myProfile.color : prereqDone ? T.success : T.border;
                return (
                  <div key={task.id} style={{ background: cardBg, border: `1px solid ${cardBorder}`, borderLeft: `2px solid ${cardLeft}`, padding: 10, marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
                      <div style={{ color: browseComplete || prereqDone ? T.success : T.textBright, fontSize: T.fs2, fontWeight: "bold", flex: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", textDecoration: browseComplete || prereqDone ? "line-through" : "none" }}>{task.name}{task.wikiLink && <a href={task.wikiLink} target="_blank" rel="noreferrer" style={{ background: T.blue + "22", color: T.blue, border: `1px solid ${T.blue}44`, padding: "2px 6px", fontSize: T.fs1, letterSpacing: 0.5, fontFamily: T.sans, whiteSpace: "nowrap", textDecoration: "none", fontWeight: "normal" }}>WIKI ↗</a>}</div>
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        {prereqDone ? (
                          <span style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "4px 8px", fontSize: T.fs2, fontFamily: T.sans, letterSpacing: 1 }}>PREREQ ✓</span>
                        ) : (<>
                          {added && !browseComplete && (
                            <button onClick={() => saveMyProfile({ ...myProfile, progress: markTaskCompleteInProgress(myProfile.id, task.id, task, myProfile.progress || {}) })} style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>✓ DONE</button>
                          )}
                          {added && browseComplete && (
                            <button onClick={() => { const p = { ...(myProfile.progress || {}) }; (task.objectives || []).forEach(obj => { delete p[`${myProfile.id}-${task.id}-${obj.id}`]; }); saveMyProfile({ ...myProfile, progress: p }); }} style={{ background: T.errorBg, border: `1px solid ${T.errorBorder}`, color: T.error, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>↩ UNDO</button>
                          )}
                          <button onClick={() => added ? removeTask(task.id) : addTask(task.id)} style={{ background: added ? T.errorBg : "transparent", border: `1px solid ${added ? T.errorBorder : T.borderBright}`, color: added ? T.error : T.textDim, padding: "4px 8px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans }}>{added ? "✕" : "+ ADD"}</button>
                        </>)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 4 }}>
                      {taskTrader === "all" && <Badge label={task.trader?.name || "?"} color={T.textDim} />}
                      {task.map && <Badge label={task.map.name} color={T.blue} />}
                      {task.minPlayerLevel > 1 && <Badge label={`Lvl ${task.minPlayerLevel}+`} color={T.textDim} />}
                      <Badge label={`${(task.objectives || []).filter(o => !o.optional).length} obj`} color={T.textDim} />
                      {unlocksMap[task.id] > 0 && <Badge label={`unlocks ${unlocksMap[task.id]}`} color={T.cyan} />}
                      {autoCompleted && <Badge label="AUTO" color={T.cyan} />}
                      {(task.objectives || []).some(o => o.zones?.length > 0 || o.possibleLocations?.length > 0) && <Badge label="has pins" color={T.success} />}
                    </div>
                    {task.objectives?.filter(o => !o.optional).slice(0, 2).map(obj => <div key={obj.id} style={{ fontSize: T.fs3, color: T.textDim, marginTop: 2 }}>{getObjMeta(obj).icon} {obj.description}</div>)}
                  </div>
                );
              });
            })()}
            {!loading && browseTasks.length === 0 && (
              <div style={{ textAlign: "center", padding: 20, color: T.textDim, fontSize: T.fs3 }}>
                No tasks match your filters. Try a different trader or clear your search.
              </div>
            )}
            <div style={{ height: 20 }} />
          </>
        )}

        {/* ── MY TASKS SUB-TAB ── */}
        {/* ── TARKOVTRACKER SYNC ── */}
        {profileSub === "tasks" && (
          <div style={{ marginBottom: 14 }}>
            <button onClick={() => setTtExpanded(!ttExpanded)} style={{ width: "100%", background: ttExpanded ? T.cyan + "15" : T.surface, border: `1px solid ${ttExpanded ? T.cyanBorder : T.border}`, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: T.sans }}>
              <span style={{ color: T.cyan, letterSpacing: 1, fontSize: T.fs2 }}>⟳ SYNC FROM TARKOVTRACKER<Tip text="Import your quest progress from TarkovTracker.io. Completed tasks sync your progress, and any newly available tasks (all prerequisites done, level met) are automatically added to your task list." /></span>
              <span style={{ color: T.textDim, fontSize: T.fs2 }}>{ttExpanded ? "▴" : "▾"}</span>
            </button>
            {ttExpanded && (
              <div style={{ background: T.surface, border: `1px solid ${T.cyanBorder}`, borderTop: "none", padding: 12 }}>
                {ttToken ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: T.fs2, color: T.success, flex: 1 }}>● Token saved</div>
                    <button onClick={() => { saveTtToken(""); setTtTokenInput(""); setTtSyncStatus("idle"); setTtSyncMsg(""); }} style={{ background: "transparent", border: `1px solid ${T.errorBorder}`, color: T.error, padding: "4px 10px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans }}>CLEAR</button>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: T.fs1, color: T.textDim, marginBottom: 6, lineHeight: 1.5 }}>
                      1. Create a free account at <a href="https://tarkovtracker.io" target="_blank" rel="noreferrer" style={{ color: T.cyan, textDecoration: "none" }}>tarkovtracker.io</a><br />
                      2. Go to Settings → Create API Token (enable "Read Progression")<br />
                      3. Paste the token below
                    </div>
                    <input value={ttTokenInput} onChange={e => setTtTokenInput(e.target.value)} placeholder="Paste TarkovTracker API token..."
                      aria-label="TarkovTracker API token"
                      style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
                  </>
                )}
                <button onClick={syncFromTarkovTracker} disabled={ttSyncStatus === "syncing" || (!ttToken && !ttTokenInput.trim())}
                  style={{ width: "100%", background: ttSyncStatus === "syncing" ? T.textDim : T.cyan, color: T.bg, border: "none", padding: "10px 0", fontSize: T.fs2, fontFamily: T.sans, fontWeight: "bold", letterSpacing: 1.5, cursor: ttSyncStatus === "syncing" ? "default" : "pointer" }}>
                  {ttSyncStatus === "syncing" ? "SYNCING..." : "⟳ SYNC TASKS"}
                </button>
                {ttSyncMsg && (
                  <div style={{ fontSize: T.fs1, color: ttSyncStatus === "error" ? T.error : T.success, marginTop: 8, lineHeight: 1.5 }}>{ttSyncMsg}</div>
                )}
              </div>
            )}
          </div>
        )}

        {profileSub === "tasks" && (() => {
          const myTasksWithApi = (myProfile.tasks || []).map(t => {
            const apiTask = apiTasks?.find(x => x.id === t.taskId);
            return apiTask ? { taskId: t.taskId, apiTask } : null;
          }).filter(Boolean);
          const isTaskComplete = ({ taskId, apiTask }) => {
            const prog = myProfile.progress || {};
            const reqObjs = (apiTask.objectives || []).filter(o => !o.optional);
            const completedObjs = reqObjs.filter(obj => { const k = `${myProfile.id}-${taskId}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }).length;
            return completedObjs >= reqObjs.length && reqObjs.length > 0;
          };
          myTasksWithApi.sort((a, b) => {
            const ac = isTaskComplete(a), bc = isTaskComplete(b);
            if (ac !== bc) return ac ? 1 : -1;
            const aAny = !a.apiTask.map, bAny = !b.apiTask.map;
            if (!ac && !bc && aAny !== bAny) return aAny ? 1 : -1;
            return progressionSort(a.apiTask, b.apiTask);
          });
          const completedFromLogs = new Set(myProfile.completedTasks || []);
          const renderCard = ({ taskId, apiTask }) => {
            const prog = myProfile.progress || {};
            const reqObjs = (apiTask.objectives || []).filter(o => !o.optional);
            const completedObjs = reqObjs.filter(obj => { const k = `${myProfile.id}-${taskId}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }).length;
            const totalObjs = reqObjs.length;
            const autoCompleted = completedFromLogs.has(taskId);
            const isComplete = autoCompleted || (completedObjs >= totalObjs && totalObjs > 0);
            const traderName = apiTask.trader?.name || "Unknown";
            const incompleteObjs = reqObjs.filter(obj => { const k = `${myProfile.id}-${taskId}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) < meta.total; });
            return (
              <div key={taskId} style={{ background: isComplete ? T.successBg : T.surface, border: `1px solid ${isComplete ? T.successBorder : T.border}`, borderLeft: `2px solid ${isComplete ? T.success : T.border}`, padding: 10, marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  {taskGroupBy !== "trader" && traderImgMap[traderName] && <img src={traderImgMap[traderName]} alt={traderName} style={{ width: 24, height: 24, borderRadius: "50%", border: `1px solid ${myProfile.color}44`, objectFit: "cover", flexShrink: 0, marginTop: 2 }} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ color: isComplete ? T.success : T.textBright, fontSize: T.fs2, fontWeight: "bold", textDecoration: isComplete ? "line-through" : "none", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{apiTask.name}{apiTask.wikiLink && <a href={apiTask.wikiLink} target="_blank" rel="noreferrer" style={{ background: T.blue + "22", color: T.blue, border: `1px solid ${T.blue}44`, padding: "2px 6px", fontSize: T.fs1, letterSpacing: 0.5, fontFamily: T.sans, whiteSpace: "nowrap", textDecoration: "none", fontWeight: "normal" }}>WIKI ↗</a>}</div>
                    <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                      {taskGroupBy !== "trader" && <Badge label={traderName} color={myProfile.color} />}
                      {taskGroupBy !== "map" && (apiTask.map ? <Badge label={apiTask.map.name} color={T.blue} /> : <Badge label="ANY MAP" color={T.cyan} />)}
                      <span style={{ fontSize: T.fs2, color: isComplete ? T.success : T.textDim }}>{completedObjs}/{totalObjs} obj</span>
                      {autoCompleted && <span style={{ fontSize: T.fs1, color: T.cyan, letterSpacing: 0.8, background: T.cyan + "22", border: `1px solid ${T.cyan}44`, padding: "1px 5px" }}>AUTO</span>}
                    </div>
                    {!isComplete && (() => {
                      const showAll = incompleteObjs.length <= 6;
                      const visible = showAll ? incompleteObjs : incompleteObjs.slice(0, 2);
                      return <>
                        {visible.map(obj => {
                          const meta = getObjMeta(obj);
                          return <div key={obj.id} style={{ fontSize: T.fs1, color: T.textDim, marginTop: 3 }}><span style={{ color: meta.color }}>{meta.icon}</span> {obj.description}</div>;
                        })}
                        {!showAll && <button onClick={() => setExpandedTask(expandedTask === taskId ? null : taskId)} style={{ background: "transparent", border: "none", color: T.blue, fontSize: T.fs1, cursor: "pointer", padding: 0, marginTop: 3, fontFamily: T.sans }}>{expandedTask === taskId ? "▴ show less" : `▾ +${incompleteObjs.length - 2} more`}</button>}
                        {!showAll && expandedTask === taskId && incompleteObjs.slice(2).map(obj => {
                          const meta = getObjMeta(obj);
                          return <div key={obj.id} style={{ fontSize: T.fs1, color: T.textDim, marginTop: 3 }}><span style={{ color: meta.color }}>{meta.icon}</span> {obj.description}</div>;
                        })}
                      </>;
                    })()}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                    {!isComplete && <button onClick={() => saveMyProfile({ ...myProfile, progress: markTaskCompleteInProgress(myProfile.id, taskId, apiTask, myProfile.progress || {}) })} style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>✓ DONE</button>}
                    {isComplete && <button onClick={() => { const p = { ...(myProfile.progress || {}) }; (apiTask.objectives || []).forEach(obj => { delete p[`${myProfile.id}-${taskId}-${obj.id}`]; }); saveMyProfile({ ...myProfile, progress: p }); }} style={{ background: T.errorBg, border: `1px solid ${T.errorBorder}`, color: T.error, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>↩ UNDO</button>}
                    {!isComplete && apiTask.map && onRouteTask && <button onClick={() => onRouteTask(taskId, apiTask.map.id)} style={{ background: T.gold + "22", border: `1px solid ${T.gold}`, color: T.gold, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>▶ ROUTE</button>}
                    <button onClick={() => removeTask(taskId)} style={{ background: "transparent", border: "none", color: T.errorBorder, cursor: "pointer", fontSize: T.fs4, padding: "0 4px" }}>×</button>
                  </div>
                </div>
              </div>
            );
          };
          // Build groups
          const buildGroups = () => {
            if (taskGroupBy === "az") return [{ key: "all", label: null, tasks: myTasksWithApi }];
            const groups = {};
            myTasksWithApi.forEach(item => {
              const gk = taskGroupBy === "trader" ? (item.apiTask.trader?.name || "Unknown") : (item.apiTask.map?.name || "Any Map");
              if (!groups[gk]) groups[gk] = [];
              groups[gk].push(item);
            });
            const sortedKeys = Object.keys(groups).sort(taskGroupBy === "trader" ? traderSort : (a, b) => a.localeCompare(b));
            return sortedKeys.map(k => ({ key: k, label: k, tasks: groups[k] }));
          };
          const groups = buildGroups();
          return (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <SL c={<>MY TASKS ({myProfile.tasks?.length || 0})<Tip text="Browse and add the tasks you're currently working on. These get included in your share code so your squad knows what objectives you need to hit." /></>} s={{ marginBottom: 0 }} />
                <button onClick={() => setProfileSub("browse")} style={{ background: myProfile.color + "22", border: `2px solid ${myProfile.color}`, color: myProfile.color, padding: "6px 12px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>+ BROWSE TASKS</button>
              </div>
              {myProfile.tasks?.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                  {[{id:"az",label:"A-Z"},{id:"trader",label:"TRADER"},{id:"map",label:"MAP"}].map(o => (
                    <button key={o.id} onClick={() => setTaskGroupBy(o.id)} style={{ flex: 1, background: taskGroupBy === o.id ? myProfile.color + "22" : "transparent", border: `1px solid ${taskGroupBy === o.id ? myProfile.color : T.border}`, color: taskGroupBy === o.id ? myProfile.color : T.textDim, padding: "5px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textAlign: "center" }}>{o.label}</button>
                  ))}
                </div>
              )}
              {myProfile.tasks?.length > 0 && taskGroupBy === "trader" && (
                <div style={{ display: "flex", gap: 5, marginBottom: 8, flexWrap: "wrap" }}>
                  {groups.filter(g => g.label).map(g => {
                    const completedAll = g.tasks.every(item => isTaskComplete(item));
                    const clr = completedAll && g.tasks.length > 0 ? T.success : myProfile.color;
                    return (
                      <button key={g.key} onClick={() => { const el = document.getElementById("mytasks-group-" + g.key.replace(/\s+/g, "-")); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }} style={{
                        display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", fontSize: T.fs1, fontFamily: T.sans,
                        background: clr + "18", border: `1px solid ${clr}55`, color: clr, cursor: "pointer",
                      }}>
                        {traderImgMap[g.label] && <img src={traderImgMap[g.label]} alt={g.label} style={{ width: 18, height: 18, borderRadius: "50%", objectFit: "cover" }} />}
                        <span>{g.label}</span>
                      </button>
                    );
                  })}
                  <Tip text="Tap a trader to jump to their section below." />
                </div>
              )}
              {myProfile.tasks?.length > 0 && (
                <button onClick={() => { if (window.confirm("Clear all " + myProfile.tasks.length + " tasks?")) saveMyProfile({ ...myProfile, tasks: [], progress: {} }); }} style={{ width: "100%", background: T.errorBg, border: `2px solid ${T.errorBorder}`, color: T.error, padding: "8px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>✕ CLEAR ALL TASKS</button>
              )}
              {!myProfile.tasks?.length && (
                <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 20, textAlign: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 8 }}>No tasks added yet</div>
                  <button onClick={() => setProfileSub("browse")} style={{ background: "transparent", border: `2px solid ${myProfile.color}`, color: myProfile.color, padding: "8px 16px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>BROWSE ALL TASKS →</button>
                </div>
              )}
              {groups.map(g => {
                const completedCount = g.tasks.filter(({ taskId, apiTask }) => {
                  const prog = myProfile.progress || {};
                  const objs = (apiTask.objectives || []).filter(o => !o.optional);
                  const done = objs.filter(obj => (prog[`${myProfile.id}-${taskId}-${obj.id}`] || 0) >= getObjMeta(obj).total).length;
                  return done >= objs.length && objs.length > 0;
                }).length;
                return (
                  <div key={g.key} id={g.label ? "mytasks-group-" + g.key.replace(/\s+/g, "-") : undefined} style={{ marginBottom: g.label ? 12 : 0 }}>
                    {g.label && (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: myProfile.color + "11", borderLeft: `2px solid ${myProfile.color}`, marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {taskGroupBy === "trader" && traderImgMap[g.label] && <img src={traderImgMap[g.label]} alt={g.label} style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${myProfile.color}44`, objectFit: "cover" }} />}
                          <div style={{ fontSize: T.fs3, color: myProfile.color, fontWeight: "bold", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase" }}>{g.label}</div>
                        </div>
                        <div style={{ fontSize: T.fs2, color: completedCount === g.tasks.length && g.tasks.length > 0 ? T.success : T.textDim, fontFamily: T.sans }}>{completedCount}/{g.tasks.length} done</div>
                      </div>
                    )}
                    {g.tasks.map(renderCard)}
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* ── HIDEOUT SUB-TAB ── */}
        {profileSub === "hideout" && (() => {
          const stations = apiHideout?.filter(s => s.levels.length > 0).sort((a, b) => a.name.localeCompare(b.name)) || [];
          const maxedCount = stations.filter(s => (hideoutLevels[s.id] || 0) >= Math.max(...s.levels.map(l => l.level))).length;
          const stationIcons = {
            "Air Filtering Unit":"◎","Bitcoin Farm":"₿","Booze Generator":"⚗","Cultist Circle":"⁂",
            "Defective Wall":"▦","Generator":"⚡","Gym":"⚔","Hall of Fame":"★","Heating":"♨",
            "Illumination":"☀","Intelligence Center":"◈","Lavatory":"⚙","Library":"≡",
            "Medstation":"✚","Nutrition Unit":"⊟","Rest Space":"☾","Scav Case":"▣","Security":"⊕",
            "Shooting Range":"◎","Solar Power":"☼","Stash":"▤","Vents":"≋","Water Collector":"◇","Workbench":"⊞",
          };
          return (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <SL c={<>MY HIDEOUT ({maxedCount}/{stations.length} maxed)<Tip text="Tap a station to see upgrade requirements and set your current level. Use TARGET to mark what you're working toward — it's included in your share code." /></>} s={{ marginBottom: 0 }} />
              </div>

              {/* Current target banner */}
              {hideoutTarget && apiHideout ? (() => {
                const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
                const level = station?.levels.find(l => l.level === hideoutTarget.level);
                return station && level ? (
                  <div style={{ background: myProfile.color + "11", border: `1px solid ${myProfile.color}44`, borderLeft: `2px solid ${myProfile.color}`, padding: 10, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: T.fs1, letterSpacing: 1.5, color: myProfile.color }}>★ TARGET</div>
                        <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>{station.name} → Lv {hideoutTarget.level}</div>
                      </div>
                      <button onClick={() => saveHideoutTarget(null)} style={{ background: "transparent", border: `2px solid ${T.errorBorder}`, color: T.error, padding: "3px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans }}>CLEAR</button>
                    </div>
                    <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 4 }}>
                      {level.itemRequirements.slice(0, 3).map(r => `${r.item.shortName || r.item.name} ×${r.count}`).join(", ")}
                      {level.itemRequirements.length > 3 && ` +${level.itemRequirements.length - 3} more`}
                    </div>
                  </div>
                ) : null;
              })() : (
                <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 12, textAlign: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim }}>No target set — tap a station below</div>
                </div>
              )}

              {/* Prereq prompt */}
              {hideoutPrereq && (
                <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.orange, marginBottom: 6 }}>PREREQUISITES NEEDED</div>
                  <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>
                    <span style={{ color: T.textBright, fontWeight: "bold" }}>{hideoutPrereq.stationName} Level {hideoutPrereq.level}</span> requires upgrades you don't have yet.
                  </div>
                  {hideoutPrereq.unmet.map((req, i) => {
                    const prereqStation = apiHideout?.find(s => s.id === req.stationId);
                    const prereqItems = prereqStation?.levels.find(l => l.level === req.level)?.itemRequirements?.filter(r => r.item.name !== "Roubles") || [];
                    return (
                      <button key={i} onClick={() => { saveHideoutTarget({ stationId: req.stationId, level: req.level }); setHideoutPrereq(null); }}
                        style={{ width: "100%", background: myProfile.color + "11", border: `2px solid ${myProfile.color}44`, padding: "8px 10px", marginBottom: 4, cursor: "pointer", textAlign: "left" }}>
                        <div style={{ fontSize: T.fs2, color: myProfile.color, fontWeight: "bold" }}>{req.stationName} → Level {req.level}</div>
                        {prereqItems.length > 0 && <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>{prereqItems.slice(0, 4).map(r => `${r.item.shortName || r.item.name} ×${r.count}`).join(", ")}{prereqItems.length > 4 ? " ..." : ""}</div>}
                      </button>
                    );
                  })}
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={() => { saveHideoutTarget({ stationId: hideoutPrereq.stationId, level: hideoutPrereq.level }); setHideoutPrereq(null); }}
                      style={{ flex: 1, background: "transparent", border: `2px solid ${T.border}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>TARGET ANYWAY</button>
                    <button onClick={() => setHideoutPrereq(null)}
                      style={{ flex: 1, background: "transparent", border: `2px solid ${T.border}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>CANCEL</button>
                  </div>
                </div>
              )}

              {/* Station grid — 2-column like in-game hideout */}
              {apiHideout ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  {stations.map(station => {
                    const curLevel = hideoutLevels[station.id] || 0;
                    const maxLevel = Math.max(...station.levels.map(l => l.level));
                    const isMaxed = curLevel >= maxLevel;
                    const isTarget = hideoutTarget?.stationId === station.id;
                    const isExpanded = expandedStation === station.id;
                    const icon = stationIcons[station.name] || "◇";
                    const nextLevel = !isMaxed ? station.levels.find(l => l.level === curLevel + 1) : null;
                    const canUpgradeNext = nextLevel ? (nextLevel.stationLevelRequirements || []).every(req => (hideoutLevels[req.station.id] || 0) >= req.level) : false;
                    return (
                      <div key={station.id} style={{
                        gridColumn: isExpanded ? "1 / -1" : undefined,
                        background: isMaxed ? T.successBg : (isTarget ? myProfile.color + "08" : T.surface),
                        border: `1px solid ${isMaxed ? T.successBorder : (isTarget ? myProfile.color + "44" : T.border)}`,
                        borderLeft: `2px solid ${isMaxed ? T.success : (isTarget ? myProfile.color : (!isMaxed && canUpgradeNext ? T.orange + "66" : T.border))}`,
                        padding: isExpanded ? 10 : 8,
                      }}>
                        {/* Tile header — clickable */}
                        <div onClick={() => setExpandedStation(isExpanded ? null : station.id)}
                          style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: isExpanded ? T.fs4 : T.fs3, color: isMaxed ? T.success : (isTarget ? myProfile.color : T.textDim), lineHeight: 1, flexShrink: 0, width: isExpanded ? 24 : 18, textAlign: "center" }}>{icon}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: T.fs2, fontWeight: "bold",
                              color: isMaxed ? T.success : T.textBright,
                              textDecoration: "none",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>{station.name}</div>
                            {/* Level progress bar */}
                            <div style={{ display: "flex", gap: 1, marginTop: 3 }}>
                              {maxLevel > 0 && Array.from({ length: maxLevel }, (_, i) => (
                                <div key={i} style={{
                                  flex: 1, height: 3, borderRadius: 1,
                                  background: i < curLevel ? (isMaxed ? T.success : (isTarget ? myProfile.color : T.success + "88")) : T.border,
                                }} />
                              ))}
                            </div>
                          </div>
                          <div style={{ fontSize: T.fs1, color: isMaxed ? T.success : T.textDim, flexShrink: 0 }}>
                            {isMaxed ? <Badge label="MAX" color={T.success} small /> : `${curLevel}/${maxLevel}`}
                          </div>
                        </div>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                            {/* Level selector */}
                            <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 1, marginBottom: 4 }}>SET LEVEL</div>
                            <div style={{ display: "flex", gap: 3, marginBottom: 10, flexWrap: "wrap" }}>
                              {Array.from({ length: maxLevel + 1 }, (_, i) => (
                                <button key={i} onClick={() => saveHideoutLevels({ ...hideoutLevels, [station.id]: i })}
                                  style={{
                                    width: 30, height: 26, fontSize: T.fs2, fontFamily: T.sans,
                                    background: curLevel === i ? myProfile.color + "22" : "transparent",
                                    border: `2px solid ${curLevel === i ? myProfile.color : T.border}`,
                                    color: curLevel === i ? myProfile.color : (i < curLevel ? T.success : T.textDim),
                                    cursor: "pointer",
                                  }}>{i}</button>
                              ))}
                            </div>

                            {/* Next upgrade requirements */}
                            {!isMaxed && nextLevel && (
                              <>
                                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>UPGRADE TO LEVEL {curLevel + 1}</div>
                                {nextLevel.itemRequirements.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    {nextLevel.itemRequirements.map((req, i) => (
                                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.border}` }}>
                                        <span style={{ fontSize: T.fs2, color: T.text }}>{req.item.name}</span>
                                        <Badge label={`×${req.count}`} color={myProfile.color} small />
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {nextLevel.traderRequirements?.length > 0 && (
                                  <div style={{ marginBottom: 6 }}>
                                    {nextLevel.traderRequirements.map((req, i) => (
                                      <div key={i} style={{ fontSize: T.fs2, color: T.orange, marginBottom: 2 }}>Requires {req.trader.name} LL{req.level}</div>
                                    ))}
                                  </div>
                                )}
                                {nextLevel.stationLevelRequirements?.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    {nextLevel.stationLevelRequirements.map((req, i) => {
                                      const met = (hideoutLevels[req.station.id] || 0) >= req.level;
                                      return <div key={i} style={{ fontSize: T.fs2, color: met ? T.success : T.error, marginBottom: 2 }}>{met ? "✓" : "✕"} {req.station.name} Level {req.level}</div>;
                                    })}
                                  </div>
                                )}
                              </>
                            )}

                            {/* Target buttons */}
                            {!isMaxed && (
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {station.levels.filter(l => l.level > curLevel).map(l => {
                                  const isThisTarget = isTarget && hideoutTarget.level === l.level;
                                  const canBuildIt = (l.stationLevelRequirements || []).every(req => (hideoutLevels[req.station.id] || 0) >= req.level);
                                  return (
                                    <button key={l.level}
                                      onClick={() => {
                                        if (isThisTarget) { saveHideoutTarget(null); return; }
                                        const unmet = (l.stationLevelRequirements || []).filter(req => (hideoutLevels[req.station.id] || 0) < req.level).map(req => ({ stationId: req.station.id, stationName: req.station.name, level: req.level }));
                                        if (unmet.length > 0) { setHideoutPrereq({ stationName: station.name, stationId: station.id, level: l.level, unmet }); }
                                        else { saveHideoutTarget({ stationId: station.id, level: l.level }); }
                                      }}
                                      style={{
                                        background: isThisTarget ? myProfile.color + "22" : "transparent",
                                        border: `2px solid ${isThisTarget ? myProfile.color : T.border}`,
                                        color: isThisTarget ? myProfile.color : (canBuildIt ? T.textDim : T.error + "88"),
                                        padding: "4px 10px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1,
                                      }}
                                    >{isThisTarget ? "★ " : ""}TARGET L{l.level}{!canBuildIt ? " (prereq)" : ""}</button>
                                  );
                                })}
                              </div>
                            )}

                            {isMaxed && (
                              <div style={{ fontSize: T.fs2, color: T.success, textAlign: "center", padding: 6 }}>✓ FULLY UPGRADED</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ color: T.textDim, fontSize: T.fs2, textAlign: "center", padding: 20 }}>Loading hideout data...</div>
              )}
            </>
          );
        })()}

        {/* ── TASK TREES SUB-TAB ── */}
        {profileSub === "chains" && (() => {
          const allTasks = apiTasks || [];
          // Build tree for selected trader (or all)
          const filteredTasks = chainTrader === "all" ? allTasks : allTasks.filter(t => t.trader?.name === chainTrader);
          const filteredIds = new Set(filteredTasks.map(t => t.id));
          // Build children map: prereqId -> tasks that require it
          const childrenMap = {};
          const hasParent = new Set();
          filteredTasks.forEach(task => {
            (task.taskRequirements || []).forEach(req => {
              if (req.status?.includes("complete") && req.task?.id && filteredIds.has(req.task.id)) {
                if (!childrenMap[req.task.id]) childrenMap[req.task.id] = [];
                childrenMap[req.task.id].push(task);
                hasParent.add(task.id);
              }
            });
          });
          // Sort children by progression
          Object.values(childrenMap).forEach(arr => arr.sort(progressionSort));
          const roots = filteredTasks.filter(t => !hasParent.has(t.id)).sort(progressionSort);
          const toggleNode = (id) => setExpandedChainNodes(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
          const expandAll = () => { const all = new Set(); filteredTasks.forEach(t => { if (childrenMap[t.id]?.length) all.add(t.id); }); setExpandedChainNodes(all); };
          const collapseAll = () => setExpandedChainNodes(new Set());
          const myPrereqIds = new Set();
          (myProfile.tasks || []).forEach(({ taskId }) => { getAllPrereqTaskIds(taskId, apiTasks).forEach(id => myPrereqIds.add(id)); });
          const isAdded = (id) => myProfile.tasks?.some(t => t.taskId === id);
          const isComplete = (task) => {
            if (!isAdded(task.id) && myPrereqIds.has(task.id)) return true;
            const prog = myProfile.progress || {};
            const objs = (task.objectives || []).filter(o => !o.optional);
            if (!objs.length) return false;
            return objs.every(obj => { const k = `${myProfile.id}-${task.id}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; });
          };
          const getProgress = (task) => {
            const prog = myProfile.progress || {};
            const objs = (task.objectives || []).filter(o => !o.optional);
            const completed = objs.filter(obj => { const k = `${myProfile.id}-${task.id}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }).length;
            return { completed, total: objs.length };
          };
          const renderNode = (task, depth) => {
            const kids = childrenMap[task.id] || [];
            const hasKids = kids.length > 0;
            const isExp = expandedChainNodes.has(task.id);
            const added = isAdded(task.id);
            const done = isComplete(task);
            const progress = added ? getProgress(task) : null;
            const nodeColor = done ? T.success : added ? myProfile.color : T.textDim;
            return (
              <div key={task.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", marginLeft: depth * 20, background: done ? T.successBg : added ? myProfile.color + "11" : "transparent", borderLeft: `2px solid ${nodeColor}`, marginBottom: 2, cursor: hasKids ? "pointer" : "default" }} onClick={() => hasKids && toggleNode(task.id)}>
                  <span style={{ fontSize: T.fs3, color: nodeColor, width: 14, textAlign: "center", flexShrink: 0 }}>{hasKids ? (isExp ? "▼" : "▶") : "─"}</span>
                  <span style={{ fontSize: T.fs2, color: done ? T.success : T.textBright, fontWeight: "bold", flex: 1, textDecoration: done ? "line-through" : "none" }}>{task.name}</span>
                  {progress && <span style={{ fontSize: T.fs1, color: done ? T.success : progress.completed > 0 ? myProfile.color : T.textDim, fontFamily: T.sans, whiteSpace: "nowrap" }}>{progress.completed}/{progress.total} obj</span>}
                  {task.wikiLink && <a href={task.wikiLink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ background: T.blue + "22", color: T.blue, border: `1px solid ${T.blue}44`, padding: "2px 6px", fontSize: T.fs1, letterSpacing: 0.5, fontFamily: T.sans, whiteSpace: "nowrap", textDecoration: "none", fontWeight: "normal" }}>WIKI ↗</a>}
                  {hasKids && <span style={{ fontSize: T.fs1, color: T.textDim, fontFamily: T.sans }}>{kids.length}</span>}
                </div>
                {hasKids && isExp && (
                  <div style={{ borderLeft: `1px solid ${T.border}`, marginLeft: depth * 20 + 15 }}>
                    {kids.map(child => renderNode(child, depth + 1))}
                  </div>
                )}
              </div>
            );
          };
          // Cross-trader prereqs note
          const crossTraderTasks = chainTrader !== "all" ? filteredTasks.filter(t =>
            (t.taskRequirements || []).some(r => r.status?.includes("complete") && r.task?.id && !filteredIds.has(r.task.id))
          ) : [];
          return (
            <>
              <SL c={<>TASK TREES<Tip text="Explore task prerequisite chains by trader. Expand nodes to see what each task unlocks. Green = completed, highlighted = in your task list." /></>} s={{ marginBottom: 8 }} />
              <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1.5, marginBottom: 6, fontFamily: T.sans }}>TRADER</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {["all", ...traders].map(tr => (
                  <button key={tr} onClick={() => { setChainTrader(tr); setExpandedChainNodes(new Set()); }} style={{ display: "flex", alignItems: "center", gap: 4, background: chainTrader === tr ? myProfile.color + "22" : "transparent", border: `1px solid ${chainTrader === tr ? myProfile.color : T.border}`, color: chainTrader === tr ? myProfile.color : T.textDim, padding: "6px 10px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans }}>
                    {tr !== "all" && traderImgMap[tr] && <img src={traderImgMap[tr]} alt={tr} style={{ width: 18, height: 18, borderRadius: "50%", objectFit: "cover" }} />}
                    {tr === "all" ? "ALL" : tr}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <button onClick={expandAll} style={{ flex: 1, background: "transparent", border: `1px solid ${T.borderBright}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>EXPAND ALL</button>
                <button onClick={collapseAll} style={{ flex: 1, background: "transparent", border: `1px solid ${T.borderBright}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>COLLAPSE ALL</button>
              </div>
              <div style={{ fontSize: T.fs3, color: T.textDim, letterSpacing: 1, marginBottom: 8 }}>{roots.length} ROOT{roots.length !== 1 ? "S" : ""} · {filteredTasks.length} TASKS</div>
              {crossTraderTasks.length > 0 && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 8, marginBottom: 10, fontSize: T.fs2, color: T.textDim }}>
                  ⚠ {crossTraderTasks.length} task{crossTraderTasks.length !== 1 ? "s have" : " has"} prerequisites from other traders (shown as roots here)
                </div>
              )}
              {roots.map(task => renderNode(task, 0))}
              {roots.length === 0 && <div style={{ color: T.textDim, fontSize: T.fs2, textAlign: "center", padding: 20 }}>{apiTasks ? "No tasks found" : "Loading..."}</div>}
            </>
          );
        })()}

        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}
