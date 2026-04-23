import { useEffect, useMemo, useRef, useState } from "react";
import { T } from "../theme.js";
import { buildMatchIndex, findTopMatches } from "../lib/fuzzyMatch.js";
import { invoke } from "../lib/tauri.js";
import { mergeTaskLines, isAmbiguousPartSiblings, expandSeriesAlternates, PART_FRAGMENT_RE } from "../lib/taskScanUtils.js";
import { Tip } from "./ui/index.js";

// Short, quiet system-confirmation chirp via Web Audio. Cross-platform and
// dependency-free — used when an immediate (no-countdown) scan completes
// while the main window is behind Tarkov, so the user hears that their
// Ctrl+Alt+T keypress landed.
function playScanBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* silent — beep is nice-to-have */
  }
}

// Threshold under which an OCR line is discarded entirely. Task names are
// long multi-token phrases, so 0.75 works alongside tokenScore's bidirectional
// coverage to drop location-column leakage ("Lighthouse" → "Revision –
// Lighthouse") while still accepting real task-name captures.
const MIN_MATCH_SCORE = 0.75;

// Auto-check any match with confidence at or above this. User can still
// uncheck it. Lower-confidence matches surface in the list but start
// unchecked so the default "Import" action is conservative.
const AUTO_CHECK_SCORE = 0.9;

// Tarkov map names that appear in the notebook's Location column. When an
// OCR line is exactly one of these, the match is almost certainly leakage
// from the location column rather than a task-name read. We still propose
// the match (there IS a Prapor task literally named "Reserve", so we don't
// hard-reject), but start it unchecked so the user has to opt in.
const LOCATION_NAMES = new Set([
  "customs", "factory", "woods", "shoreline", "interchange", "reserve",
  "labs", "the lab", "lighthouse", "streets of tarkov", "ground zero",
  "any location",
]);

// Multiple similar-looking OCR lines can match the same task (wrapped
// text, repeated UI). We dedupe by taskId and keep the highest-scoring
// line as the single proposal for that task.

const COUNTDOWN_SECONDS = 5;


export default function TaskScannerModal({
  apiTasks,
  myProfile,
  saveMyProfile,
  scanMode = "countdown",
  scanTrigger = 0,
  onClose,
}) {
  // `scanMode === "immediate"` means Ctrl+Alt+T fired while the user was in
  // Tarkov — skip the countdown entirely and go straight to capture.
  const [phase, setPhase] = useState(scanMode === "immediate" ? "scanning" : "countdown");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [error, setError] = useState(null);
  const [rawLines, setRawLines] = useState([]);
  const [showRaw, setShowRaw] = useState(false);
  // proposals[i] = { line, task, score, checked, alternates, userToggled }
  const [proposals, setProposals] = useState([]);
  // Track scanMode in a ref so the scanning effect can read it without
  // re-running whenever the mode flips between triggers.
  const scanModeRef = useRef(scanMode);
  useEffect(() => { scanModeRef.current = scanMode; }, [scanMode]);

  // Pre-built match index. Task names lack shortNames, so shortName is "" —
  // matching happens against name + tokens only. Rebuilding this per OCR line
  // (which findTopMatches would do via normalizeIndex) would tokenize all
  // ~300 tasks hundreds of times; one memo avoids that.
  const matchIndex = useMemo(() => {
    const candidates = (apiTasks || []).map((t) => ({
      id: t.id,
      name: t.name,
      shortName: "",
      _task: t,
    }));
    return buildMatchIndex(candidates);
  }, [apiTasks]);

  // React to scanTrigger bumps from the parent — each Ctrl+Alt+T press (or
  // Profile-tab button click) increments the counter, telling us to re-run
  // the capture. In immediate mode we go straight to scanning; in
  // countdown mode we reset the countdown so the user has time to Alt+Tab.
  // Initial mount skips this (trigger equals its starting value), because
  // the scanning effect will already fire for phase="scanning" via the
  // initial-state branch.
  const lastTriggerRef = useRef(scanTrigger);
  useEffect(() => {
    if (scanTrigger === lastTriggerRef.current) return;
    lastTriggerRef.current = scanTrigger;
    setError(null);
    if (scanMode === "immediate") {
      setPhase("scanning");
    } else {
      setCountdown(COUNTDOWN_SECONDS);
      setPhase("countdown");
    }
  }, [scanTrigger, scanMode]);

  // Countdown so the user can Alt+Tab back to Tarkov before capture fires.
  // 5s is the sweet spot — enough to recover from an alt-tab fumble, not so
  // long that the user thinks the app hung. "Scan now" button bypasses it
  // when the user is already on Tarkov's display.
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
        const mergedLines = mergeTaskLines(lines);
        const existingIds = new Set((myProfile?.tasks || []).map((t) => t?.taskId).filter(Boolean));
        // Merge with any pre-existing proposals (from a previous scan pass
        // via the Rescan button), keeping whichever capture scored higher
        // for each task id.
        const byTaskId = new Map();
        for (const p of proposals) byTaskId.set(p.task.id, p);
        for (const rawLine of mergedLines) {
          const line = (rawLine || "").trim();
          // Drop Part-N fragments that survived the merge pass — either
          // dashed ("- Part 3") or bare ("Part 1"). These are always
          // continuation fragments from an adjacent task-name line; on
          // their own they'd false-match random Part-N tasks (e.g. a
          // stray "Part 1" scoring 80% against Gunsmith – Part 1).
          if (PART_FRAGMENT_RE.test(line)) continue;
          const matches = findTopMatches(line, matchIndex, 3, MIN_MATCH_SCORE);
          if (matches.length === 0) continue;
          const primary = matches[0];
          const taskId = primary.item.id;
          if (existingIds.has(taskId)) continue; // already tracked on profile
          const prev = byTaskId.get(taskId);
          if (prev && prev.score >= primary.score) continue;

          let alternates = matches.slice(1).map((m) => m.item._task);
          const isLocationLine = LOCATION_NAMES.has(line.toLowerCase());
          const isAmbiguousSeries = isAmbiguousPartSiblings(primary.item, alternates, line);
          // For ambiguous numbered-series picks (OCR couldn't capture the
          // Part number), surface every sibling in the series so the user
          // can swap to Part 5 even when findTopMatches only returned the
          // first three equally-scoring parts.
          if (isAmbiguousSeries) {
            alternates = expandSeriesAlternates(primary.item, alternates, apiTasks);
          }
          // Auto-check only when confidence is high AND the match isn't
          // from a location-column leak AND isn't an ambiguous numbered-
          // series pick. Falls back to the previous proposal's check
          // state on re-scan so the user's toggles survive.
          const shouldAutoCheck =
            primary.score >= AUTO_CHECK_SCORE &&
            !isLocationLine &&
            !isAmbiguousSeries;

          byTaskId.set(taskId, {
            line,
            task: primary.item._task,
            score: primary.score,
            // Preserve the user's check state only if they've actually
            // interacted with this row. Untouched proposals get the
            // freshly-computed auto-check so rescans pick up improvements
            // (or intentional changes) in the auto-check heuristic.
            checked: prev?.userToggled ? prev.checked : shouldAutoCheck,
            userToggled: prev?.userToggled ?? false,
            alternates,
          });
        }
        const list = Array.from(byTaskId.values()).sort((a, b) => b.score - a.score);
        setProposals(list);
        setPhase("review");
        // Audible confirmation for the Ctrl+Alt+T-from-Tarkov flow — the
        // user is usually looking at Tarkov when this completes, so a beep
        // tells them the capture landed without needing to Alt+Tab to
        // verify. Countdown flow doesn't beep (user is already in-app).
        if (scanModeRef.current === "immediate") {
          playScanBeep();
        }
      } catch (e) {
        if (cancelled) return;
        setError(String(e?.message || e));
        setPhase("error");
      }
    })();
    return () => { cancelled = true; };
    // `proposals` intentionally not in deps — we want to read the current
    // value when a rescan fires, but re-running the effect whenever
    // proposals changes (every toggle) would re-trigger OCR. The phase
    // transition back to "scanning" via rescan is what re-runs us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, matchIndex, myProfile]);

  const checkedCount = useMemo(() => proposals.filter((p) => p.checked).length, [proposals]);

  const toggle = (idx) => {
    setProposals((prev) => prev.map((p, i) => (
      i === idx ? { ...p, checked: !p.checked, userToggled: true } : p
    )));
  };
  const swapAlternate = (idx, alternate) => {
    setProposals((prev) =>
      prev.map((p, i) =>
        i === idx
          ? {
              ...p,
              task: alternate,
              alternates: [p.task, ...p.alternates.filter((a) => a.id !== alternate.id)],
              userToggled: true,
            }
          : p
      )
    );
  };
  const selectAll = () => setProposals((prev) => prev.map((p) => ({ ...p, checked: true, userToggled: true })));
  const selectNone = () => setProposals((prev) => prev.map((p) => ({ ...p, checked: false, userToggled: true })));

  // Rescan keeps the current proposals and re-runs the capture/match pass.
  // The scanning effect merges new matches into the existing set, so the
  // user can scroll the notebook between scans and accumulate proposals
  // across pages/tabs without losing anything they've already reviewed.
  const rescan = () => {
    setCountdown(COUNTDOWN_SECONDS);
    setError(null);
    setPhase("countdown");
  };

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
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
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
          {phase === "review" && rawLines.length > 0 && (
            <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 8, display: "flex", alignItems: "center", gap: 0 }}>
              <button
                onClick={() => setShowRaw((v) => !v)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: T.textDim,
                  fontSize: T.fs1,
                  padding: 0,
                  cursor: "pointer",
                  fontFamily: T.sans,
                  textDecoration: "underline",
                }}
              >
                {showRaw ? "▾ Hide" : "▸ Show"} raw OCR ({rawLines.length} line{rawLines.length === 1 ? "" : "s"})
              </button>
              <Tip text="Every text line Windows OCR picked up from the screen capture, before fuzzy matching. Useful for diagnosing misses — if your task name isn't here, the capture or font is the problem; if it is but didn't match, the threshold or tokenization is." />
            </div>
          )}
          {phase === "review" && showRaw && rawLines.length > 0 && (
            <div style={{
              marginTop: 6,
              background: T.inputBg,
              border: `1px solid ${T.border}`,
              padding: "6px 8px",
              maxHeight: 200,
              overflowY: "auto",
              fontFamily: T.mono,
              fontSize: T.fs1,
              color: T.textDim,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}>
              {rawLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
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
          {(phase === "review" || phase === "error") && (
            <button
              onClick={rescan}
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
            >Rescan</button>
          )}
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
