import { useEffect, useState } from "react";
import { T } from "../theme.js";
import { SL, Tip } from "./ui/index.js";

// Phase A+B: resolves the Tarkov logs directory, scans every session under
// it, pairs RaidStarted + RaidEnded events by shortId, and shows a raid
// history card. Phase C will add settings/toggle, Phase B-live the `notify`
// watcher, Phase D the Supabase sync.

function parseTs(ts) {
  // "2026-04-18 15:27:53.331" → Date
  if (!ts) return null;
  const iso = ts.replace(" ", "T");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDuration(ms) {
  if (ms == null || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function prettyMap(raw) {
  if (!raw) return "?";
  // Normalize Tarkov internal map names to display names
  const MAP = {
    factory4_day: "Factory (Day)",
    factory4_night: "Factory (Night)",
    Interchange: "Interchange",
    bigmap: "Customs",
    Woods: "Woods",
    Shoreline: "Shoreline",
    RezervBase: "Reserve",
    Lighthouse: "Lighthouse",
    Laboratory: "Labs",
    TarkovStreets: "Streets",
    Sandbox: "Ground Zero",
    Sandbox_high: "Ground Zero (High)",
  };
  return MAP[raw] || raw;
}

function buildLogSummary(sessions) {
  const starts = new Map();
  const raids = [];
  const completedTasks = new Map(); // questId -> { ts, traderId }
  const failedTasks = new Map();
  const startedTasks = new Map();

  for (const session of sessions) {
    for (const ev of session.events || []) {
      if (ev.type === "raidStarted") {
        starts.set(ev.shortId, { startTs: ev.ts, map: ev.map, gameMode: ev.gameMode, shortId: ev.shortId });
      } else if (ev.type === "raidEnded") {
        const started = starts.get(ev.shortId);
        if (started) {
          const startDate = parseTs(started.startTs);
          const endDate = parseTs(ev.ts);
          const durMs = startDate && endDate ? endDate.getTime() - startDate.getTime() : null;
          raids.push({
            shortId: ev.shortId,
            map: started.map || ev.map,
            gameMode: started.gameMode,
            start: started.startTs,
            end: ev.ts,
            durationMs: durMs,
            complete: true,
          });
          starts.delete(ev.shortId);
        } else {
          raids.push({ shortId: ev.shortId, map: ev.map, gameMode: "", start: null, end: ev.ts, durationMs: null, complete: true });
        }
      } else if (ev.type === "taskFinished") {
        completedTasks.set(ev.questId, { ts: ev.ts, traderId: ev.traderId });
      } else if (ev.type === "taskFailed") {
        failedTasks.set(ev.questId, { ts: ev.ts, traderId: ev.traderId });
      } else if (ev.type === "taskStarted") {
        startedTasks.set(ev.questId, { ts: ev.ts, traderId: ev.traderId });
      }
    }
  }
  for (const s of starts.values()) {
    raids.push({ shortId: s.shortId, map: s.map, gameMode: s.gameMode, start: s.startTs, end: null, durationMs: null, complete: false });
  }
  raids.sort((a, b) => {
    const ta = parseTs(a.start || a.end)?.getTime() || 0;
    const tb = parseTs(b.start || b.end)?.getTime() || 0;
    return tb - ta;
  });
  return {
    raids,
    completedTaskIds: Array.from(completedTasks.keys()),
    failedTaskIds: Array.from(failedTasks.keys()),
    // A task counts as "active" if it started but we haven't seen it
    // complete/fail afterwards.
    activeTaskIds: Array.from(startedTasks.keys()).filter(
      (id) => !completedTasks.has(id) && !failedTasks.has(id)
    ),
  };
}

export default function LogWatcherSection({ myProfile, saveMyProfile }) {
  const [logsDir, setLogsDir] = useState(null);
  const [detecting, setDetecting] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [raids, setRaids] = useState(() => myProfile?.raidHistory || null);
  const [sessionCount, setSessionCount] = useState(0);
  const [taskCounts, setTaskCounts] = useState({
    completed: myProfile?.completedTasks?.length || 0,
    failed: myProfile?.failedTasks?.length || 0,
    active: myProfile?.activeTasks?.length || 0,
  });
  const [lastScannedAt, setLastScannedAt] = useState(
    myProfile?.lastLogSync ? new Date(myProfile.lastLogSync) : null
  );
  const [error, setError] = useState(null);
  const isTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

  useEffect(() => {
    if (!isTauri) { setDetecting(false); return; }
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const dir = await invoke("detect_tarkov_logs_dir");
        setLogsDir(dir || null);
      } catch (e) { setError(String(e?.message || e)); }
      setDetecting(false);
    })();
  }, [isTauri]);

  const scanAll = async () => {
    if (!logsDir) return;
    setScanning(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sessions = await invoke("scan_logs_dir", { logsDir });
      setSessionCount(Array.isArray(sessions) ? sessions.length : 0);
      const summary = buildLogSummary(sessions || []);
      setRaids(summary.raids);
      setTaskCounts({
        completed: summary.completedTaskIds.length,
        failed: summary.failedTaskIds.length,
        active: summary.activeTaskIds.length,
      });
      const now = new Date();
      setLastScannedAt(now);
      // Persist everything into the profile. Supabase squad-room sync picks
      // up the updated profile shape automatically.
      if (typeof saveMyProfile === "function" && myProfile) {
        const completedRaids = summary.raids.filter((r) => r.complete);
        saveMyProfile({
          ...myProfile,
          raidHistory: completedRaids,
          completedTasks: summary.completedTaskIds,
          failedTasks: summary.failedTaskIds,
          activeTasks: summary.activeTaskIds,
          lastLogSync: now.toISOString(),
        });
      }
    } catch (e) {
      setError(String(e?.message || e));
    }
    setScanning(false);
  };

  // Auto-scan once on mount (after the logs directory resolves) and on
  // window focus — so returning from a Tarkov raid refreshes the history
  // without needing a manual click. Not real-time, but matches the
  // "post-raid sync only" decision in the backlog.
  useEffect(() => {
    if (!logsDir) return;
    scanAll();
    const onFocus = () => { scanAll(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsDir]);

  if (!isTauri) return null;

  return (
    <>
      <SL c={<>LOG WATCHER<Tip text="Reads your Tarkov log files from disk to reconstruct raid history (map, duration, game mode). Safe — logs are local files, BattlEye never flags disk reads. Phase A+B: manual scan. Live watching, post-raid Supabase sync, and settings come in later phases." /></>} />
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.cyan}`, padding: 12, marginBottom: 16 }}>
        <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8, marginBottom: 4 }}>LOGS DIRECTORY</div>
        <div style={{ fontSize: T.fs1, color: logsDir ? T.textBright : T.error, fontFamily: T.mono, marginBottom: 10, wordBreak: "break-all" }}>
          {detecting ? "Detecting…" : logsDir || "Not found — standard install path not detected"}
        </div>
        <button
          onClick={scanAll}
          disabled={!logsDir || scanning}
          style={{
            width: "100%",
            background: logsDir && !scanning ? T.cyan + "22" : "transparent",
            border: `1px solid ${logsDir && !scanning ? T.cyan : T.border}`,
            color: logsDir && !scanning ? T.cyan : T.textDim,
            padding: "8px 0",
            fontSize: T.fs2,
            cursor: logsDir && !scanning ? "pointer" : "default",
            fontFamily: T.sans,
            letterSpacing: 1,
          }}
        >
          {scanning ? "SCANNING…" : raids ? "REFRESH" : "SCAN LOGS"}
        </button>
        {error && <div style={{ fontSize: T.fs1, color: T.error, marginTop: 8 }}>{error}</div>}
        {raids && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>COMPLETED</div>
                <div style={{ fontSize: T.fs3, color: T.success, fontWeight: "bold" }}>{taskCounts.completed}</div>
              </div>
              <div style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>ACTIVE</div>
                <div style={{ fontSize: T.fs3, color: T.cyan, fontWeight: "bold" }}>{taskCounts.active}</div>
              </div>
              <div style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>FAILED</div>
                <div style={{ fontSize: T.fs3, color: taskCounts.failed > 0 ? T.error : T.textDim, fontWeight: "bold" }}>{taskCounts.failed}</div>
              </div>
              <div style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>RAIDS</div>
                <div style={{ fontSize: T.fs3, color: T.gold, fontWeight: "bold" }}>{raids.filter(r => r.complete).length}</div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>
                RAID HISTORY · across {sessionCount} session{sessionCount === 1 ? "" : "s"}
              </div>
              {lastScannedAt && (
                <div style={{ fontSize: T.fs1, color: T.textDim }}>
                  Synced {lastScannedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto", border: `1px solid ${T.border}`, background: T.inputBg }}>
              {raids.length === 0 && (
                <div style={{ padding: 8, fontSize: T.fs1, color: T.textDim }}>No raids detected in these logs.</div>
              )}
              {raids.map((r) => (
                <div key={r.shortId} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 8px",
                  borderBottom: `1px solid ${T.border}`,
                  fontSize: T.fs1, fontFamily: T.mono,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: T.textBright }}>{prettyMap(r.map)}</div>
                    <div style={{ color: T.textDim, fontSize: T.fs1 }}>
                      {r.start ? r.start.slice(0, 16) : "?"}
                      {r.gameMode && ` · ${r.gameMode}`}
                      {" · "}{r.shortId}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right" }}>
                    <div style={{ color: r.complete ? T.textBright : T.orange, fontWeight: "bold" }}>
                      {r.complete ? fmtDuration(r.durationMs) : "in progress"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
