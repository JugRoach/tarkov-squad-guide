import { useState, useEffect, useRef } from "react";
import { T } from '../theme.js';
import { SL, Badge, Btn, Tip } from '../components/ui/index.js';
import { EMAPS } from '../lib/mapData.js';
import { ET_CONFIG, TC, categorizeKey } from '../lib/configData.js';
import { fetchAPI } from '../api.js';

export default function IntelTab() {
  const [sel, setSel] = useState(EMAPS[0]);
  const [fac, setFac] = useState("pmc");
  const [fil, setFil] = useState("all");
  const [sv, setSv] = useState("extracts");
  const [apiKeys, setApiKeys] = useState([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const keysSectionRefs = useRef({});
  const scrollToMapKeys = (mapId) => {
    const el = keysSectionRefs.current[mapId];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  useEffect(() => {
    if (sv !== "keys" || apiKeys.length > 0) return;
    setKeysLoading(true);
    fetchAPI(`{ items(type: keys) { id name shortName description gridImageLink properties { ... on ItemPropertiesKey { uses } } } }`)
      .then(d => { if (d?.items) setApiKeys(d.items); })
      .finally(() => setKeysLoading(false));
  }, [sv]);
  const exts = fac === "pmc" ? sel.pmcExtracts : sel.scavExtracts;
  const filtered = fil === "all" ? exts : exts.filter(e => e.type === fil);
  const types = [...new Set(exts.map(e => e.type))];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px 0" }}>
        <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
          {["extracts", "keys", "maps", "progression"].map(v => <Btn key={v} ch={v === "keys" ? "Keys" : v === "progression" ? "Progression" : v === "maps" ? "Maps" : v} onClick={() => setSv(v)} active={sv === v} />)}
        </div>
        {sv === "extracts" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 4, paddingBottom: 10 }}>
            {EMAPS.map(m => <button key={m.id} onClick={() => { setSel(m); setFil("all"); }} style={{ background: sel.id === m.id ? m.color + "22" : "transparent", border: `2px solid ${sel.id === m.id ? m.color : T.border}`, color: sel.id === m.id ? m.color : T.textDim, padding: "5px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center", wordBreak: "break-word" }}>{m.name}</button>)}
          </div>
          <div style={{ display: "flex", marginBottom: 10, border: `1px solid ${T.border}` }}>
            {["pmc", "scav"].map(f => <button key={f} onClick={() => { setFac(f); setFil("all"); }} style={{ flex: 1, background: fac === f ? (f === "pmc" ? T.blueBg : T.successBg) : "transparent", color: fac === f ? (f === "pmc" ? T.cyan : T.success) : T.textDim, border: "none", padding: 7, fontSize: T.fs3, letterSpacing: 1.5, cursor: "pointer", textTransform: "uppercase", fontFamily: T.sans, fontWeight: "bold" }}>{f === "pmc" ? "▲ PMC" : "◆ SCAV"}</button>)}
          </div>
        </>}
      </div>
      <div style={{ overflowY: "auto", flex: 1, padding: 14 }}>
        {sv === "progression" && <>
          <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: "10px 12px", marginBottom: 14, fontSize: T.fs2, color: "#7ab87a", lineHeight: 1.7 }}>⚔ PvE — Co-op extracts N/A. Difficulty = boss/Raider danger.</div>
          {["Beginner", "Intermediate", "Advanced", "Endgame"].map(tier => (
            <div key={tier} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: TC[tier], borderBottom: `1px solid ${TC[tier]}33`, paddingBottom: 5, marginBottom: 8, fontFamily: T.sans }}>{tier.toUpperCase()}</div>
              {EMAPS.filter(m => m.tier === tier).map(map => (
                <div key={map.id} onClick={() => { setSel(map); setSv("extracts"); setFil("all"); }} style={{ background: T.surface, border: `1px solid ${map.color}33`, borderLeft: `2px solid ${map.color}`, padding: 10, marginBottom: 7, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}><div style={{ color: map.color, fontSize: T.fs3, fontWeight: "bold" }}>{map.name}</div><div style={{ fontSize: T.fs3, color: T.textDim }}>{"★".repeat(map.diff)}{"☆".repeat(5 - map.diff)}</div></div>
                  <div style={{ fontSize: T.fs2, color: T.textDim, lineHeight: 1.5, marginBottom: 5 }}>{map.desc}</div>
                  <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 5 }}>{map.bosses.map((b, i) => <div key={i} style={{ fontSize: T.fs3, color: T.errorBorder, marginBottom: 2 }}>☠ {b}</div>)}</div>
                </div>
              ))}
            </div>
          ))}
        </>}
        {sv === "keys" && <>
          {!keysLoading && (() => {
            const mapsWithKeys = EMAPS.filter(map => {
              const extractKeys = [...map.pmcExtracts, ...map.scavExtracts].filter(e => e.type === "key");
              const mapApiKeys = apiKeys.filter(k => categorizeKey(k.name).includes(map.id));
              return extractKeys.length + mapApiKeys.length > 0;
            });
            if (mapsWithKeys.length === 0) return null;
            return (
              <div style={{ position: "sticky", top: -14, zIndex: 2, background: T.bg, paddingTop: 4, paddingBottom: 8, marginBottom: 10, marginTop: -4, borderBottom: `1px solid ${T.border}` }}>
                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 1, marginBottom: 5, display: "flex", alignItems: "center", gap: 4 }}>JUMP TO MAP<Tip text="Click a map to jump to its keys. All maps stay rendered below — scroll freely or jump with a click." /></div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 4 }}>
                  {mapsWithKeys.map(m => (
                    <button key={m.id} onClick={() => scrollToMapKeys(m.id)} style={{ background: "transparent", border: `2px solid ${T.border}`, color: T.textDim, padding: "5px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center", wordBreak: "break-word" }}>{m.name}</button>
                  ))}
                </div>
              </div>
            );
          })()}
          <div style={{ background: T.orangeBg, border: `1px solid ${ET_CONFIG.key.border}`, borderLeft: `2px solid ${ET_CONFIG.key.color}`, padding: "10px 12px", marginBottom: 14, fontSize: T.fs2, color: ET_CONFIG.key.color, lineHeight: 1.7 }}>
            <Tip text="All keys in the game, organized by map. Data pulled live from tarkov.dev. Extract keys are highlighted — these unlock extractions, not just loot rooms. Tap a map header to jump to its extract list." />
            ⚿ Every key organized by map — pulled live from tarkov.dev. Extract keys highlighted separately.
          </div>
          {keysLoading && <div style={{ textAlign: "center", color: T.textDim, padding: 30, fontSize: T.fs3 }}>Loading keys from tarkov.dev...</div>}
          {!keysLoading && EMAPS.map(map => {
            const extractKeys = [...map.pmcExtracts, ...map.scavExtracts].filter(e => e.type === "key").map(e => ({ key: e.requireItems.join(" + "), use: `Extract: ${e.name}`, isExtract: true }));
            const uniqueExtractKeys = extractKeys.filter((k, i, arr) => arr.findIndex(a => a.key === k.key) === i);
            const mapApiKeys = apiKeys.filter(k => categorizeKey(k.name).includes(map.id));
            const totalCount = uniqueExtractKeys.length + mapApiKeys.length;
            if (totalCount === 0) return null;
            return (
              <div key={map.id} ref={el => { keysSectionRefs.current[map.id] = el; }} style={{ marginBottom: 16, scrollMarginTop: 70 }}>
                <div onClick={() => { setSel(map); setSv("extracts"); setFil("key"); }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", borderBottom: `1px solid ${map.color}33`, paddingBottom: 6, marginBottom: 8 }}>
                  <div style={{ color: map.color, fontSize: T.fs3, fontWeight: "bold", letterSpacing: 1 }}>{map.name.toUpperCase()}</div>
                  <div style={{ fontSize: T.fs1, color: T.textDim }}>{totalCount} key{totalCount !== 1 ? "s" : ""} →</div>
                </div>
                {uniqueExtractKeys.map((k, i) => (
                  <div key={"ext-"+i} style={{ background: T.orangeBg, border: `1px solid ${ET_CONFIG.key.border}`, borderLeft: `2px solid ${ET_CONFIG.key.color}`, padding: "8px 10px", marginBottom: 5, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: T.fs3, color: ET_CONFIG.key.color, fontWeight: "bold" }}>⚿ {k.key}</div>
                      <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 3 }}>{k.use}</div>
                    </div>
                    <Badge label="EXTRACT" color={ET_CONFIG.key.color} small />
                  </div>
                ))}
                {mapApiKeys.map(k => {
                  const uses = k.properties?.uses;
                  return (
                    <div key={k.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.textDim}`, padding: "8px 10px", marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
                      <img src={k.gridImageLink} alt="" style={{ width: 36, height: 36, objectFit: "contain", flexShrink: 0, background: T.bg, border: `1px solid ${T.border}` }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: T.fs3, color: T.textBright, fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name}</div>
                        <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>{uses ? `${uses} uses` : ""}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>}
        {sv === "extracts" && <>
          <div style={{ background: T.surface, border: `1px solid ${sel.color}33`, borderLeft: `2px solid ${sel.color}`, padding: 10, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ color: sel.color, fontSize: T.fs2, fontWeight: "bold" }}>{sel.name}</div><Badge label={sel.tier} color={TC[sel.tier]} /></div>
            <div style={{ fontSize: T.fs2, color: T.textDim, margin: "5px 0 7px", lineHeight: 1.5 }}>{sel.desc}</div>
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 6 }}>{sel.bosses.map((b, i) => <div key={i} style={{ fontSize: T.fs3, color: T.errorBorder, marginBottom: 2 }}>☠ {b}</div>)}</div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <SL c="FILTER" s={{ marginBottom: 6 }} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <Btn ch={`All (${exts.length})`} compact active={fil === "all"} onClick={() => setFil("all")} />
              {types.map(t => { const c = ET_CONFIG[t]; return <button key={t} onClick={() => setFil(t)} style={{ background: fil === t ? c.bg : "transparent", color: fil === t ? c.color : T.textDim, border: `1px solid ${fil === t ? c.border : T.border}`, padding: "4px 8px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans }}>{c.icon} {exts.filter(e => e.type === t).length}</button>; })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((ext, i) => {
              const c = ET_CONFIG[ext.type]; const dead = ext.type === "coop";
              return (
                <div key={i} style={{ background: c.bg, border: `1px solid ${c.border}`, borderLeft: `2px solid ${c.color}`, padding: 10, opacity: dead ? 0.5 : 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ color: dead ? T.borderBright : T.textBright, fontSize: T.fs3, fontWeight: "bold", flex: 1, textDecoration: dead ? "line-through" : "none" }}>{ext.name}</div>
                    <div style={{ background: c.border + "44", color: c.color, fontSize: T.fs1, letterSpacing: 1, padding: "2px 6px", whiteSpace: "nowrap", marginLeft: 8 }}>{c.icon} {c.label.toUpperCase()}</div>
                  </div>
                  <div style={{ marginTop: 5, fontSize: T.fs2, color: dead ? T.borderBright : c.color, lineHeight: 1.5 }}>{ext.note}</div>
                  {ext.requireItems?.length > 0 && (
                    <div style={{ marginTop: 7, paddingTop: 6, borderTop: `1px solid ${c.border}44` }}>
                      <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 4 }}>REQUIRED ITEMS:</div>
                      {ext.requireItems.map(item => <div key={item} style={{ fontSize: T.fs3, color: c.color, marginBottom: 2 }}>• {item}</div>)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, padding: 10, border: `1px solid ${T.border}`, background: T.surface }}>
            <SL c={<>LEGEND<Tip text="Open extracts are always available. Key extracts need a specific key. Pay extracts cost roubles. Special extracts require items like a Red Rebel or Paracord. Co-op extracts are disabled in PvE." /></>} s={{ marginBottom: 7 }} />
            {Object.entries(ET_CONFIG).map(([t, c]) => <div key={t} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><div style={{ width: 6, height: 6, background: c.border, flexShrink: 0 }} /><div style={{ fontSize: T.fs2, color: c.color, width: 14 }}>{c.icon}</div><div style={{ fontSize: T.fs3, color: t === "coop" ? T.borderBright : T.textDim }}>{c.label}</div></div>)}
          </div>
        </>}
        {sv === "maps" && <>
          <SL c={<>INTERACTIVE MAPS — ALL SOURCES<Tip text="Quick links to the best interactive maps for each location. Open them in a second tab while planning your raid." /></>} />
          {EMAPS.map(map => (
            <div key={map.id} style={{ background: T.surface, border: `1px solid ${map.color}22`, borderLeft: `2px solid ${map.color}`, padding: 10, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><div style={{ color: map.color, fontSize: T.fs3, fontWeight: "bold" }}>{map.name}</div><Badge label={map.tier} color={TC[map.tier]} /></div>
              <div style={{ display: "flex", gap: 6 }}>
                <a href={map.tarkovdev} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: T.blueBg, border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "8px 0", fontSize: T.fs2, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center" }}>tarkov.dev</a>
                <a href={map.mapgenie} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: T.blueBg, border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "8px 0", fontSize: T.fs2, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center" }}>mapgenie</a>
                <a href={map.wiki} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: T.surface, border: `1px solid ${map.color}33`, color: map.color, padding: "8px 0", fontSize: T.fs2, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center" }}>wiki</a>
              </div>
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}
