import { useState } from "react";
import { T, PLAYER_COLORS } from '../theme.js';
import { SL, Tip } from '../components/ui/index.js';
import { encodeProfile, decodeProfile } from '../lib/shareCodes.js';

export default function ProfileTab({ myProfile, saveMyProfile, setTab }) {
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [restoreCode, setRestoreCode] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const copyCode = () => {
    const code = encodeProfile(myProfile); if (!code) return;
    try { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => { const ta = document.createElement("textarea"); ta.value = code; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); setCopied(true); setTimeout(() => setCopied(false), 2500); }); } catch(e) {}
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
          { platform: "iPhone / iPad", color: T.purple, steps: ["Open this page in Safari (must be Safari, not Chrome)", "Tap the Share icon (box with arrow pointing up)", "Scroll down and tap Add to Home Screen", "Name it Tarkov Guide and tap Add"] },
          { platform: "Android", color: T.success, steps: ["Open this page in Chrome", "Tap the ⋮ menu (top-right)", "Tap Add to Home screen or Install app", "Tap Add or Install to confirm"] },
          { platform: "Windows / Mac (Chrome or Edge)", color: T.gold, steps: ["Open this page in Chrome or Edge", "Look for the install icon (⊕) in the address bar", "Or: ⋮ menu → Save and share → Install page as app", "Name it Tarkov Guide and click Install"] },
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
