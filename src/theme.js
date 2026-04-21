// Design tokens & shared constants
export const T = {
  bg:"#0d0e10",surface:"#1a1917",surfaceAlt:"#222018",surfaceHover:"#2a2720",border:"#2d2a24",borderBright:"#3d3930",gold:"#d2af78",text:"#c7c5b3",textDim:"#8a8070",textMid:"#8a8478",textBright:"#f0ead8",
  sans:"'Bender','Segoe UI',-apple-system,Roboto,sans-serif",mono:"'Courier New',Consolas,monospace",
  // Semantic colors
  error:"#d44040",errorBg:"#1f1414",errorBorder:"#4a2020",
  success:"#4daa4d",successBg:"#141f14",successBorder:"#2a5a2a",
  cyan:"#4ab0b0",cyanBg:"#141e1e",cyanBorder:"#2a4a4a",
  orange:"#c08040",orangeBg:"#1f1a14",orangeBorder:"#5a4020",
  blue:"#5a90b0",blueBg:"#141a1f",blueBorder:"#2a4060",
  purple:"#9080b0",purpleBg:"#1a141f",purpleBorder:"#3a2a5a",
  // Consolidated input/surface colors
  inputBg:"#151412",
  // Gold-tinted background overlays (button rest/active states, highlight cells)
  goldBgSubtle:"rgba(210,175,120,0.06)",
  goldBgLight:"rgba(210,175,120,0.15)",
  // Spacing scale
  sp1:4, sp2:8, sp3:12, sp4:16, sp5:24,
  // Font sizes (1.25 ratio scale)
  fs1:11, fs2:13, fs3:15, fs4:17, fs5:20, fs6:26,
  // Touch target minimum
  touch:44,
  // Accent border
  accent:2,
  // Border radius
  r1:4, r2:4,
  // Input base style
  input:{ background:"#151412", border:"1px solid #2d2a24", color:"#f0ead8", padding:"10px 12px", fontSize:13, fontFamily:"'Bender','Segoe UI',-apple-system,Roboto,sans-serif", outline:"none", boxSizing:"border-box", borderRadius:4 },
};
export const PLAYER_COLORS = ["#c8a84b","#5a9aba","#9a5aba","#5aba8a","#ba7a5a"];
export const MAX_SQUAD = 5;
