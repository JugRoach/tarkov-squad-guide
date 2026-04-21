import { useState, useEffect } from "react";
import { T, PLAYER_COLORS } from '../theme.js';
import { SL, Tip } from '../components/ui/index.js';
import LogWatcherSection from '../components/LogWatcherSection.jsx';
import { encodeProfile, decodeProfile } from '../lib/shareCodes.js';
import { TRADERS, FLEA_UNLOCK_LEVEL } from '../lib/availability.js';
import { DEFAULT_SCANNER_THRESHOLD } from '../constants.js';
import { useUpdater } from '../hooks/useUpdater.js';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard.js';

const DESKTOP_RELEASES_URL = "https://github.com/JugRoach/tarkov-planner/releases/latest";
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

function DesktopAppSection() {
  const { isTauri, status, info, error, progress, checkForUpdates, installUpdate } = useUpdater();

  if (!isTauri) {
    // Web/PWA mode — show download card instead
    return (
      <>
        <SL c={<>DESKTOP APP<Tip text="Native Windows app with in-game hover-to-scan for item prices, always-on-top overlay mode, and global hotkeys. Free — auto-updates." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.goldBorder || T.gold + "44"}`, borderLeft: `2px solid ${T.gold}`, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: T.fs3, color: T.gold, fontWeight: "bold", marginBottom: 6 }}>Get the Windows desktop app</div>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7, marginBottom: 10 }}>
            The desktop version adds hover-to-scan item prices, an always-on-top overlay for use while in raid, and global hotkeys. Works alongside Tarkov.
          </div>
          <div style={{ fontSize: T.fs1, color: T.textDim, lineHeight: 1.6, marginBottom: 10 }}>
            ✓ One-click install · ✓ Auto-updates · ✓ Free &amp; open source
          </div>
          <a
            href={DESKTOP_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "block",
              width: "100%",
              background: T.gold,
              color: T.bg,
              border: "none",
              padding: "12px 0",
              fontSize: T.fs3,
              textAlign: "center",
              cursor: "pointer",
              fontFamily: T.sans,
              letterSpacing: 1,
              textTransform: "uppercase",
              fontWeight: "bold",
              textDecoration: "none",
              borderRadius: T.r2,
              boxSizing: "border-box",
            }}
          >
            ⇩ DOWNLOAD FOR WINDOWS
          </a>
          <div style={{ fontSize: T.fs1, color: T.textDim, textAlign: "center", marginTop: 6 }}>Opens GitHub — download the .msi or setup.exe</div>
        </div>
      </>
    );
  }

  // Tauri mode — show version + update UI
  const busy = status === "checking" || status === "downloading" || status === "installing";
  return (
    <>
      <SL c={<>DESKTOP APP<Tip text="Check for updates, view release notes, and install the latest version. The app also checks automatically on startup." /></>} />
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`, padding: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: T.fs3, color: T.textBright, fontWeight: "bold" }}>Tarkov Planner</div>
            <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>Version {APP_VERSION}</div>
          </div>
          <button
            onClick={() => checkForUpdates(false)}
            disabled={busy}
            style={{
              background: busy ? T.surface : "rgba(210,175,120,0.06)",
              border: `1px solid ${T.border}`,
              color: T.textDim,
              padding: "6px 12px",
              fontSize: T.fs1,
              fontFamily: T.sans,
              cursor: busy ? "wait" : "pointer",
              borderRadius: T.r1,
              letterSpacing: 0.5,
              whiteSpace: "nowrap",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {status === "checking" ? "CHECKING…" : "CHECK FOR UPDATES"}
          </button>
        </div>

        {status === "uptodate" && (
          <div style={{ fontSize: T.fs2, color: T.success, padding: "6px 8px", background: T.successBg, border: `1px solid ${T.successBorder}`, borderRadius: T.r1 }}>
            ✓ You're on the latest version.
          </div>
        )}

        {status === "available" && info && (
          <div style={{ background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, borderRadius: T.r1, padding: 10 }}>
            <div style={{ fontSize: T.fs2, color: T.cyan, fontWeight: "bold", marginBottom: 4 }}>
              New version available: {info.version}
            </div>
            {info.body && (
              <div style={{ fontSize: T.fs1, color: T.text, lineHeight: 1.6, marginBottom: 8, maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap" }}>
                {info.body}
              </div>
            )}
            <button
              onClick={installUpdate}
              style={{
                width: "100%",
                background: T.cyan,
                color: T.bg,
                border: "none",
                padding: "10px 0",
                fontSize: T.fs2,
                fontFamily: T.sans,
                cursor: "pointer",
                letterSpacing: 1,
                textTransform: "uppercase",
                fontWeight: "bold",
                borderRadius: T.r2,
              }}
            >
              ⇩ Download &amp; Install
            </button>
          </div>
        )}

        {status === "downloading" && (
          <div style={{ padding: "6px 0" }}>
            <div style={{ fontSize: T.fs1, color: T.cyan, marginBottom: 4 }}>
              Downloading… {Math.round(progress * 100)}%
            </div>
            <div style={{ height: 4, background: T.border, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress * 100}%`, background: T.cyan, transition: "width 0.2s" }} />
            </div>
          </div>
        )}

        {status === "installing" && (
          <div style={{ fontSize: T.fs2, color: T.cyan }}>Installing — the app will relaunch shortly…</div>
        )}

        {status === "error" && error && (
          <div style={{ fontSize: T.fs1, color: T.error, padding: "6px 8px", background: T.errorBg, border: `1px solid ${T.errorBorder}`, borderRadius: T.r1 }}>
            Update failed: {error}
          </div>
        )}
      </div>
    </>
  );
}

export default function ProfileTab({ myProfile, saveMyProfile, setTab }) {
  const { copied, copy } = useCopyToClipboard();
  const [editingName, setEditingName] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [restoreCode, setRestoreCode] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const copyCode = () => {
    const code = encodeProfile(myProfile);
    if (code) copy(code);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>

        {/* ── NAME & COLOR ── */}
        <SL c={<>YOUR PROFILE<Tip text="Set your callsign and pick a color. This is how your squadmates will see you on the route map." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${myProfile.color}44`, borderLeft: `2px solid ${myProfile.color}`, padding: 12, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: myProfile.color + "33", border: `2px solid ${myProfile.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs4, color: myProfile.color, flexShrink: 0 }}>{myProfile.name?.[0]?.toUpperCase() || "?"}</div>
            {editingName ? (
              <input aria-label="Profile name" autoFocus value={myProfile.name || ""} onChange={e => saveMyProfile({ ...myProfile, name: e.target.value })} onBlur={() => setEditingName(false)} onKeyDown={e => e.key === "Enter" && setEditingName(false)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px solid ${myProfile.color}`, color: myProfile.color, fontSize: T.fs4, fontFamily: T.sans, outline: "none", padding: "2px 0" }} />
            ) : (
              <div style={{ flex: 1, color: myProfile.color, fontSize: T.fs4, fontWeight: "bold", cursor: "pointer" }} onClick={() => setEditingName(true)}>
                {myProfile.name || "Tap to set name"}<span style={{ fontSize: T.fs2, color: T.textDim, fontWeight: "normal", marginLeft: 6 }}>✎</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {PLAYER_COLORS.map((col, i) => <button key={i} onClick={() => saveMyProfile({ ...myProfile, color: col })} style={{ width: 24, height: 24, borderRadius: "50%", background: col, cursor: "pointer", border: myProfile.color === col ? "2px solid #d8d0c0" : "2px solid transparent", padding: 0 }} />)}
          </div>
        </div>

        {/* ── GET STARTED ── */}
        {(!myProfile.name || !(myProfile.tasks || []).length) && (
          <div style={{ background: T.gold + "11", border: `2px solid ${T.gold}44`, borderRadius: T.r1, padding: T.sp4, marginBottom: T.sp4 }}>
            <div style={{ fontSize: T.fs5, color: T.gold, fontWeight: "bold", letterSpacing: 1, marginBottom: T.sp2 }}>GET STARTED</div>
            <div style={{ fontSize: T.fs3, color: T.text, lineHeight: 1.8, marginBottom: T.sp3 }}>
              {!myProfile.name && <div style={{ color: T.gold }}>1. Set your name above</div>}
              {myProfile.name && <div style={{ color: T.success }}>1. Name set ✓</div>}
              {!(myProfile.tasks || []).length ? <div style={{ color: T.gold }}>2. Go to the Tasks tab and add your active quests</div> : <div style={{ color: T.success }}>2. Tasks added ✓</div>}
              <div style={{ color: T.textDim }}>3. Copy your share code below and head to the Raid tab</div>
            </div>
            {myProfile.name && !(myProfile.tasks || []).length && (
              <button onClick={() => setTab("tasks")} style={{ width: "100%", background: T.gold, color: T.bg, border: "none", padding: "12px 0", fontSize: T.fs3, fontWeight: "bold", letterSpacing: 1, cursor: "pointer", fontFamily: T.sans, borderRadius: T.r2 }}>★ GO TO TASKS</button>
            )}
          </div>
        )}

        {/* ── PROGRESSION ── */}
        <SL c={<>PROGRESSION<Tip text={`Your PMC level, trader loyalty levels, and the scanner's pickup threshold. PMC + trader levels drive the Builds tab's "builds I can make" filter (Flea Market unlocks at PMC ${FLEA_UNLOCK_LEVEL}). The pickup threshold colors the scanner popout green (worth grabbing) or red (skip) based on the best of vendor or flea price per slot.`} /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`, padding: 12, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 0.8, flexShrink: 0, minWidth: 90 }}>PMC LEVEL</div>
            <input
              type="number"
              min={1}
              max={79}
              value={myProfile.pmcLevel ?? 1}
              onChange={(e) => {
                const n = Math.max(1, Math.min(79, parseInt(e.target.value, 10) || 1));
                saveMyProfile({ ...myProfile, pmcLevel: n });
              }}
              style={{ background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "6px 10px", fontSize: T.fs3, fontFamily: T.sans, outline: "none", width: 80, textAlign: "center" }}
            />
            <div style={{ fontSize: T.fs1, color: (myProfile.pmcLevel ?? 1) >= FLEA_UNLOCK_LEVEL ? T.success : T.textDim, flex: 1 }}>
              {(myProfile.pmcLevel ?? 1) >= FLEA_UNLOCK_LEVEL ? "Flea Market unlocked" : `Flea Market at ${FLEA_UNLOCK_LEVEL}`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 0.8, flexShrink: 0, minWidth: 90, display: "flex", alignItems: "center", gap: 4 }}>PICKUP ₽/SLOT<Tip text="The scanner popout flags hovered items above this value-per-slot as worth picking up (green ✓ border) or below as skip (red ✗). Uses whichever sells for more — flea or best trader." /></div>
            <input
              type="number"
              min={0}
              max={1000000}
              step={1000}
              value={myProfile.scannerThreshold ?? DEFAULT_SCANNER_THRESHOLD}
              onChange={(e) => {
                const n = Math.max(0, parseInt(e.target.value, 10) || 0);
                saveMyProfile({ ...myProfile, scannerThreshold: n });
              }}
              style={{ background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "6px 10px", fontSize: T.fs3, fontFamily: T.sans, outline: "none", width: 120, textAlign: "center" }}
            />
            <div style={{ fontSize: T.fs1, color: T.textDim, flex: 1, lineHeight: 1.4 }}>
              Scanner flags items above this ₽/slot (using best of vendor or flea) as worth picking up.
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10, marginTop: 4 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 0.8, marginBottom: 8 }}>TRADER LEVELS</div>
            {TRADERS.map((trader) => {
              const level = myProfile.traderLevels?.[trader] || 0;
              return (
                <div key={trader} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <div style={{ flex: 1, fontSize: T.fs2, color: T.textBright }}>{trader}</div>
                  {[0, 1, 2, 3, 4].map((l) => (
                    <button
                      key={l}
                      onClick={() => saveMyProfile({
                        ...myProfile,
                        traderLevels: { ...(myProfile.traderLevels || {}), [trader]: l },
                      })}
                      style={{
                        width: 28, height: 24,
                        background: level === l ? T.gold + "22" : "transparent",
                        border: `1px solid ${level === l ? T.gold : T.border}`,
                        color: level === l ? T.gold : T.textDim,
                        fontSize: T.fs1, fontFamily: T.sans,
                        cursor: "pointer",
                        fontWeight: level === l ? "bold" : "normal",
                      }}
                      aria-label={`${trader} LL ${l}`}
                    >
                      {l === 0 ? "—" : l}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── LOG WATCHER ── */}
        <LogWatcherSection myProfile={myProfile} saveMyProfile={saveMyProfile} />

        {/* ── SHARE CODE ── */}
        <SL c={<>YOUR SHARE CODE<Tip text="Copy this code and paste it in Discord before each raid. Your squadmates paste it in the Raid tab to import your profile and tasks." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${myProfile.color}44`, borderLeft: `2px solid ${myProfile.color}`, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7, marginBottom: 10 }}>Copy your code and paste it in Discord before each raid. Teammates import it in the Raid tab — no account needed.</div>
          <div style={{ background: T.inputBg, border: `1px solid ${T.border}`, padding: "8px 10px", marginBottom: 8, fontSize: T.fs2, color: T.textDim, fontFamily: T.mono, wordBreak: "break-all", lineHeight: 1.5 }}>{myProfile.tasks?.length > 0 ? encodeProfile(myProfile)?.slice(0, 60) + "..." : "Add tasks to generate your code"}</div>
          <button onClick={copyCode} disabled={!myProfile.tasks?.length} style={{ width: "100%", background: copied ? T.successBg : myProfile.color + "22", border: `2px solid ${copied ? T.successBorder : myProfile.color}`, color: copied ? T.success : myProfile.color, padding: "10px 0", fontSize: T.fs2, cursor: myProfile.tasks?.length ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>
            {copied ? "✓ COPIED TO CLIPBOARD" : "📋 COPY MY CODE"}
          </button>
          {!myProfile.tasks?.length && <div style={{ fontSize: T.fs2, color: T.textDim, textAlign: "center", marginTop: 6 }}>Add tasks in the Tasks tab first</div>}
          <button onClick={() => setShowRestore(!showRestore)} style={{ width: "100%", background: showRestore ? T.successBg : T.blueBg, border: `2px solid ${showRestore ? T.successBorder : T.blueBorder}`, color: showRestore ? T.success : T.blue, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, marginTop: 8, padding: "8px 0", textTransform: "uppercase" }}>{showRestore ? "▾ HIDE RESTORE" : "▸ RESTORE PROFILE FROM CODE"}</button>
          {showRestore && (
            <div style={{ background: T.inputBg, border: `1px solid ${T.border}`, padding: 10, marginTop: 4 }}>
              <div style={{ fontSize: T.fs2, color: T.textDim, lineHeight: 1.5, marginBottom: 8 }}>Paste a share code to restore your profile on this device — name, color, tasks, and progress will all transfer.</div>
              <textarea value={restoreCode} onChange={e => setRestoreCode(e.target.value)} placeholder="Paste your TG2:... code here"
                style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", resize: "none", height: 52, lineHeight: 1.4, marginBottom: 6 }} />
              {restoreError && <div style={{ fontSize: T.fs2, color: T.error, marginBottom: 6 }}>{restoreError}</div>}
              <button onClick={() => {
                setRestoreError("");
                const decoded = decodeProfile(restoreCode.trim());
                if (!decoded) { setRestoreError("Invalid code — check for typos."); return; }
                saveMyProfile({ ...myProfile, name: decoded.name, color: decoded.color, tasks: decoded.tasks, progress: decoded.progress });
                setRestoreCode(""); setShowRestore(false);
              }} disabled={!restoreCode.trim()} style={{ width: "100%", background: restoreCode.trim() ? T.successBg : "transparent", border: `2px solid ${restoreCode.trim() ? T.successBorder : T.border}`, color: restoreCode.trim() ? T.success : T.textDim, padding: "10px 0", fontSize: T.fs2, cursor: restoreCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1 }}>RESTORE MY PROFILE</button>
            </div>
          )}
        </div>

        {/* ── DESKTOP APP (download / update) ── */}
        <DesktopAppSection />

        {/* ── TARKOVTRACKER SYNC GUIDE ── */}
        <SL c={<>SYNC YOUR QUESTS<Tip text="Automatically import your in-game quest progress instead of adding tasks manually. Uses TarkovTracker — a free community tool used by thousands of Tarkov players." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: 12, marginBottom: 10 }}>
          <div style={{ fontSize: T.fs3, color: T.cyan, fontWeight: "bold", marginBottom: 6 }}>Auto-import your quest progress</div>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.8, marginBottom: 12 }}>
            Instead of manually adding each task, you can sync your actual in-game quest progress using <a href="https://tarkovtracker.io" target="_blank" rel="noreferrer" style={{ color: T.cyan, textDecoration: "none", fontWeight: "bold" }}>TarkovTracker.io</a> — a free community tracker used by thousands of Tarkov players.
          </div>
          <div style={{ fontSize: T.fs2, color: T.cyan, letterSpacing: 1, marginBottom: 8 }}>HOW TO SET IT UP</div>
          {[
            { step: "Create a TarkovTracker account", detail: "Go to tarkovtracker.io and sign up for free. You can log in with Discord, Google, or email.", link: "https://tarkovtracker.io" },
            { step: "Mark your completed quests", detail: "On TarkovTracker, check off quests you've already finished. This tells the sync which tasks are done vs in-progress. You only need to do this once — after that, TarkovMonitor can update it automatically." },
            { step: "Generate an API token", detail: "Go to Settings on TarkovTracker. Click 'Create Token' and make sure 'Read Progression' is enabled. Copy the token it gives you.", link: "https://tarkovtracker.io/settings" },
            { step: "Paste the token in this app", detail: "Go to the Tasks tab in this app. At the top you'll see 'SYNC FROM TARKOVTRACKER' — expand it, paste your token, and hit Sync. Your quests and progress will be imported instantly." },
          ].map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
              <div style={{ background: T.cyan + "22", color: T.cyan, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs3, flexShrink: 0, fontFamily: T.mono, fontWeight: "bold" }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", marginBottom: 2 }}>{s.step}</div>
                <div style={{ fontSize: T.fs1, color: T.textDim, lineHeight: 1.6 }}>{s.detail}</div>
                {s.link && <a href={s.link} target="_blank" rel="noreferrer" style={{ fontSize: T.fs1, color: T.cyan, textDecoration: "none" }}>{s.link.replace("https://", "")} →</a>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.orange}`, padding: 12, marginBottom: 10 }}>
          <div style={{ fontSize: T.fs2, color: T.orange, fontWeight: "bold", marginBottom: 4 }}>Optional: Auto-update with TarkovMonitor</div>
          <div style={{ fontSize: T.fs1, color: T.textDim, lineHeight: 1.6, marginBottom: 6 }}>
            <a href="https://github.com/the-hideout/TarkovMonitor" target="_blank" rel="noreferrer" style={{ color: T.orange, textDecoration: "none" }}>TarkovMonitor</a> is a free desktop app that runs alongside Tarkov and reads your game logs. When you complete a quest in-game, it automatically updates your TarkovTracker profile — so next time you sync here, your progress is already up to date.
          </div>
          <div style={{ fontSize: T.fs1, color: T.textDim, lineHeight: 1.6 }}>
            Download it from GitHub, connect it to your TarkovTracker account, and forget about it. It runs silently in the background while you play.
          </div>
        </div>
        <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, padding: 10, marginBottom: 16 }}>
          <div style={{ fontSize: T.fs2, color: T.success, lineHeight: 1.7 }}>✓ Free to use · ✓ No game mods needed · ✓ Safe — only reads log files · ✓ Works with Live &amp; PvE Tarkov</div>
        </div>

        {/* ── INSTALL APP ── */}
        <SL c={<>INSTALL AS APP<Tip text="Add this to your home screen for a native app experience. Runs full-screen, appears in your app launcher — no app store required." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.blueBorder}`, borderLeft: `2px solid ${T.blue}`, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: T.fs3, color: T.blue, fontWeight: "bold", marginBottom: 8 }}>Install as a native-feeling app</div>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.8 }}>Add this app to your home screen. Runs full-screen, appears in your app launcher — no app store required.</div>
        </div>
        {[
          { platform: "iPhone / iPad", color: T.purple, steps: ["Open this page in Safari (must be Safari, not Chrome)", "Tap the Share icon (box with arrow pointing up)", "Scroll down and tap Add to Home Screen", "Name it Tarkov Planner and tap Add"] },
          { platform: "Android", color: T.success, steps: ["Open this page in Chrome", "Tap the ⋮ menu (top-right)", "Tap Add to Home screen or Install app", "Tap Add or Install to confirm"] },
          { platform: "Windows / Mac (Chrome or Edge)", color: T.gold, steps: ["Open this page in Chrome or Edge", "Look for the install icon (⊕) in the address bar", "Or: ⋮ menu → Save and share → Install page as app", "Name it Tarkov Planner and click Install"] },
        ].map(({ platform, color, steps }) => (
          <div key={platform} style={{ background: T.surface, border: `1px solid ${color}33`, borderLeft: `2px solid ${color}`, padding: 12, marginBottom: 10 }}>
            <div style={{ color, fontSize: T.fs2, fontWeight: "bold", marginBottom: 8 }}>{platform}</div>
            {steps.map((s, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, alignItems: "flex-start" }}><div style={{ background: color + "22", color, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs3, flexShrink: 0, fontFamily: T.mono }}>{i + 1}</div><div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.5 }}>{s}</div></div>)}
          </div>
        ))}
        <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: 10 }}>
          <div style={{ fontSize: T.fs3, color: T.success, lineHeight: 1.8 }}>✓ No app store · ✓ Progress saved on device · ✓ Share codes work phone ↔ desktop · ✓ Live tarkov.dev data</div>
        </div>

      </div>
    </div>
  );
}
