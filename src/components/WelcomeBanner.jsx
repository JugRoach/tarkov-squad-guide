import { T } from '../theme.js';

export default function WelcomeBanner({ onDismiss }) {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(13,14,16,0.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.surface, border: `1px solid rgba(210,175,120,0.15)`, borderLeft: `2px solid ${T.gold}`, padding: 20, maxWidth: 340, boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
        <div style={{ fontSize: T.fs3, letterSpacing: 1.5, color: T.gold, marginBottom: 8 }}>FIELD GUIDE</div>
        <div style={{ fontSize: T.fs3, color: T.textBright, fontWeight: "bold", marginBottom: 10 }}>Tarkov Planner</div>
        <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.8, marginBottom: 14 }}>Each player manages their own profile. Share a code before raids — no squad secretary needed.</div>
        {["✓ Set your name in Profile, add tasks in Tasks", "✓ Copy your code → paste it in Discord", "✓ Raid tab: paste teammates' codes, select map", "✓ Pick your intended extract — item checks included", "✓ Generate route: objectives optimized, extract last", "✓ Post-raid updates only your own progress", "✓ Install as home screen app — see Profile tab"].map((t, i) => <div key={i} style={{ fontSize: T.fs2, color: T.success, marginBottom: 4 }}>{t}</div>)}
        <button onClick={onDismiss} style={{ width: "100%", background: T.gold, color: T.bg, border: "none", padding: "14px 0", fontSize: T.fs4, letterSpacing: 1.5, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", fontWeight: "bold", marginTop: 14, borderRadius: T.r2 }}>ENTER FIELD GUIDE</button>
      </div>
    </div>
  );
}
