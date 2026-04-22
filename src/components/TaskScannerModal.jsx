import { useEffect, useMemo, useState } from "react";
import { T } from "../theme.js";
import { findTopMatches } from "../lib/fuzzyMatch.js";
import { invoke } from "../lib/tauri.js";
import { Tip } from "./ui/index.js";

// Threshold under which an OCR line is discarded entirely (probably UI
// chrome, not a task name). Task names are typically >=3 distinctive
// words, so 0.6 reliably separates task text from timestamps, trader
// chatter, etc.
const MIN_MATCH_SCORE = 0.6;

// Auto-check any match with confidence at or above this. User can still
// uncheck it. Lower-confidence matches surface in the list but start
// unchecked so the default "Import" action is conservative.
const AUTO_CHECK_SCORE = 0.85;

// Multiple similar-looking OCR lines can match the same task (wrapped
// text, repeated UI). We dedupe by taskId and keep the highest-scoring
// line as the single proposal for that task.

export default function TaskScannerModal({ apiTasks, myProfile, saveMyProfile, onClose }) {
  const [phase, setPhase] = useState("countdown"); // countdown | scanning | review | error
  const [countdown, setCountdown] = useState(3);
  const [error, setError] = useState(null);
  const [rawLines, setRawLines] = useState([]);
  // proposals[i] = { line, task, score, checked, alternates }
  const [proposals, setProposals] = useState([]);

  // Countdown so the user can Alt+Tab back to Tarkov before capture fires.
  // When the global Ctrl+Alt+T shortcut triggers us, user is probably
  // already in Tarkov and a countdown just delays them — but they can't
  // dismiss it fast enough to hurt either way. 3s is a middle ground.
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      setPhase("scanning");
      return;
    }
    const id = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown, phase]);

  // Fire the OCR + match pipeline once countdown reaches 0.
  useEffect(() => {
    if (phase !== "scanning") return;
    let cancelled = false;
    (async () => {
      try {
        const lines = (await invoke("ocr_full_screen")) || [];
        if (cancelled) return;
        setRawLines(lines || []);
        const candidates = (apiTasks || []).map((t) => ({
          id: t.id,
          name: t.name,
          shortName: "", // tasks don't have short names; match is against `name`
          _task: t,
        }));
        const existingIds = new Set((myProfile?.tasks || []).map((t) => t?.taskId).filter(Boolean));
        const byTaskId = new Map(); // taskId → best proposal
        for (const line of lines) {
          const matches = findTopMatches(line, candidates, 3, MIN_MATCH_SCORE);
          if (matches.length === 0) continue;
          const primary = matches[0];
          const taskId = primary.item.id;
          if (existingIds.has(taskId)) continue; // already tracked
          const prev = byTaskId.get(taskId);
          if (prev && prev.score >= primary.score) continue;
          byTaskId.set(taskId, {
            line,
            task: primary.item._task,
            score: primary.score,
            checked: primary.score >= AUTO_CHECK_SCORE,
            alternates: matches.slice(1).map((m) => m.item._task),
          });
        }
        const list = Array.from(byTaskId.values()).sort((a, b) => b.score - a.score);
        setProposals(list);
        setPhase("review");
      } catch (e) {
        if (cancelled) return;
        setError(String(e?.message || e));
        setPhase("error");
      }
    })();
    return () => { cancelled = true; };
  }, [phase, apiTasks, myProfile]);

  const checkedCount = useMemo(() => proposals.filter((p) => p.checked).length, [proposals]);

  const toggle = (idx) => {
    setProposals((prev) => prev.map((p, i) => (i === idx ? { ...p, checked: !p.checked } : p)));
  };
  const swapAlternate = (idx, alternate) => {
    setProposals((prev) =>
      prev.map((p, i) =>
        i === idx
          ? {
              ...p,
              task: alternate,
              alternates: [p.task, ...p.alternates.filter((a) => a.id !== alternate.id)],
            }
          : p
      )
    );
  };
  const selectAll = () => setProposals((prev) => prev.map((p) => ({ ...p, checked: true })));
  const selectNone = () => setProposals((prev) => prev.map((p) => ({ ...p, checked: false })));

  const importChecked = () => {
    const picked = proposals.filter((p) => p.checked);
    if (picked.length === 0) {
      onClose();
      return;
    }
    const existingIds = new Set((myProfile?.tasks || []).map((t) => t?.taskId).filter(Boolean));
    const additions = picked
      .map((p) => ({ taskId: p.task.id }))
      .filter((t) => !existingIds.has(t.taskId));
    if (additions.length > 0) {
      saveMyProfile({
        ...myProfile,
        tasks: [...(myProfile?.tasks || []), ...additions],
      });
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(3,5,7,0.86)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div style={{
        background: T.surface,
        border: `1px solid ${T.gold}55`,
        borderLeft: `3px solid ${T.gold}`,
        borderRadius: T.r2,
        width: "min(640px, 100%)",
        maxHeight: "90vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: `1px solid ${T.border}`,
        }}>
          <div style={{ fontSize: T.fs3, color: T.gold, fontWeight: "bold", letterSpacing: 1, flex: 1 }}>
            TASK SCANNER
            <Tip text="Open Tarkov's task notebook to a tab (Active or Available), trigger the scan, and Alt+Tab back once the countdown finishes. Detected task names are fuzzy-matched against tarkov.dev data; you review before anything is imported." />
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              color: T.textDim,
              fontSize: T.fs2,
              padding: "4px 10px",
              cursor: "pointer",
              fontFamily: T.sans,
              borderRadius: T.r1,
            }}
          >Close</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
          {phase === "countdown" && (
            <div style={{ textAlign: "center", padding: "20px 10px" }}>
              <div style={{ fontSize: T.fs4, color: T.gold, fontWeight: "bold", marginBottom: 8 }}>
                Scanning in {countdown}…
              </div>
              <div style={{ fontSize: T.fs2, color: T.textDim, lineHeight: 1.6 }}>
                Alt+Tab to Tarkov now and make sure the task notebook is visible on
                the display your cursor is on. The app will OCR that display's
                whole screen when the countdown hits zero.
              </div>
              <button
                onClick={() => { setCountdown(0); setPhase("scanning"); }}
                style={{
                  marginTop: 12,
                  background: T.gold,
                  color: T.bg,
                  border: "none",
                  padding: "8px 18px",
                  fontSize: T.fs2,
                  cursor: "pointer",
                  fontFamily: T.sans,
                  letterSpacing: 1,
                  fontWeight: "bold",
                  borderRadius: T.r1,
                }}
              >Scan now</button>
            </div>
          )}
          {phase === "scanning" && (
            <div style={{ textAlign: "center", padding: "20px 10px", color: T.textDim, fontSize: T.fs2 }}>
              Capturing screen and running OCR…
            </div>
          )}
          {phase === "error" && (
            <div style={{
              background: T.errorBg,
              border: `1px solid ${T.errorBorder}`,
              borderLeft: `2px solid ${T.error}`,
              padding: "10px 12px",
              fontSize: T.fs2,
              color: T.error,
              lineHeight: 1.6,
            }}>
              Scan failed: {error}
            </div>
          )}
          {phase === "review" && proposals.length === 0 && (
            <div style={{ textAlign: "center", padding: "20px 10px", color: T.textDim, fontSize: T.fs2, lineHeight: 1.6 }}>
              No task names detected.<br />
              OCR picked up {rawLines.length} lines, but none matched a known task at confidence ≥ {Math.round(MIN_MATCH_SCORE * 100)}%.
              <div style={{ marginTop: 8, fontSize: T.fs1, color: T.textDim }}>
                Make sure Tarkov's task notebook is open to the Active or Available tab and that the cursor is on the Tarkov display before scanning.
              </div>
            </div>
          )}
          {phase === "review" && proposals.length > 0 && (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
                <div style={{ fontSize: T.fs2, color: T.textDim, flex: 1 }}>
                  {proposals.length} task{proposals.length === 1 ? "" : "s"} detected
                  {checkedCount !== proposals.length ? ` · ${checkedCount} selected` : ""}
                </div>
                <button
                  onClick={selectAll}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    fontSize: T.fs1,
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontFamily: T.sans,
                    borderRadius: T.r1,
                  }}
                >All</button>
                <button
                  onClick={selectNone}
                  style={{
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    color: T.textDim,
                    fontSize: T.fs1,
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontFamily: T.sans,
                    borderRadius: T.r1,
                  }}
                >None</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {proposals.map((p, idx) => (
                  <div key={p.task.id} style={{
                    background: p.checked ? T.goldBgSubtle : T.inputBg,
                    border: `1px solid ${p.checked ? T.gold + "55" : T.border}`,
                    borderLeft: `2px solid ${p.checked ? T.gold : T.border}`,
                    padding: "6px 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}>
                    <input
                      type="checkbox"
                      checked={p.checked}
                      onChange={() => toggle(idx)}
                      style={{ accentColor: T.gold, cursor: "pointer", flexShrink: 0 }}
                      aria-label={`Import ${p.task.name}`}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: T.fs2,
                        color: T.textBright,
                        fontWeight: "bold",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>{p.task.name}</div>
                      <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>
                        OCR: <span style={{ fontFamily: T.mono }}>{p.line}</span>
                        {" · "}
                        <span style={{ color: p.score >= AUTO_CHECK_SCORE ? T.success : T.gold }}>
                          {Math.round(p.score * 100)}%
                        </span>
                      </div>
                      {p.alternates.length > 0 && (
                        <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>
                          Or:{" "}
                          {p.alternates.map((alt, i) => (
                            <button
                              key={alt.id}
                              onClick={() => swapAlternate(idx, alt)}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: T.blue,
                                cursor: "pointer",
                                fontFamily: T.sans,
                                fontSize: T.fs1,
                                padding: 0,
                                textDecoration: "underline",
                                marginRight: i < p.alternates.length - 1 ? 6 : 0,
                              }}
                            >{alt.name}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex",
          gap: 6,
          padding: "10px 14px",
          borderTop: `1px solid ${T.border}`,
        }}>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              color: T.textDim,
              fontSize: T.fs2,
              padding: "6px 14px",
              cursor: "pointer",
              fontFamily: T.sans,
              letterSpacing: 0.5,
              borderRadius: T.r1,
            }}
          >Cancel</button>
          {phase === "review" && (
            <button
              onClick={importChecked}
              disabled={checkedCount === 0}
              style={{
                background: checkedCount > 0 ? T.gold : "transparent",
                border: `1px solid ${T.gold}`,
                color: checkedCount > 0 ? T.bg : T.textDim,
                fontSize: T.fs2,
                padding: "6px 18px",
                cursor: checkedCount > 0 ? "pointer" : "default",
                fontFamily: T.sans,
                letterSpacing: 0.5,
                fontWeight: "bold",
                borderRadius: T.r1,
              }}
            >Import {checkedCount > 0 ? checkedCount : ""}</button>
          )}
        </div>
      </div>
    </div>
  );
}
