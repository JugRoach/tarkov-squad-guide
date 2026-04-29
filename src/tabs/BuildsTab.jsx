import { useState, useEffect, useRef, useMemo } from "react";
import { T } from '../theme.js';
import { SL, Badge, Btn, Tip } from '../components/ui/index.js';
import { fetchAPI, WEAPONS_LIST_Q, weaponDetailQ } from '../api.js';
import { encodeBuild, decodeBuild } from '../lib/shareCodes.js';
import { optimizeBuild, computeTotalErgo, computeTotalRecoil } from '../lib/buildOptimizer.js';
import { calcStats, getCheapestPrice } from '../lib/buildStats.js';
import { isAvailableForProfile } from '../lib/availability.js';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard.js';
import { useStorage } from '../hooks/useStorage.js';
import { useDebouncedValue } from '../hooks/useDebounce.js';

// Slot nameIds the optimizer skips by default — must match
// DEFAULT_SKIP in buildOptimizer.js. Used here to grey out the lock
// toggle for slots whose pick is already implicitly preserved.
const IMPLICIT_SKIP_RX = /scope|sight|magazine/i;

// Turn tarkov.dev caliber strings into readable labels:
//   "Caliber556x45NATO" → "5.56x45 NATO"
//   "Caliber762x39"     → "7.62x39"
//   "Caliber338LAPUA"   → ".338 LAPUA"
//   "Caliber12g"        → "12g"
function formatCaliber(raw) {
  if (!raw) return "?";
  let s = raw.replace(/^Caliber/, "");
  // Standard calibers with 'x': 556x45 → 5.56x45
  s = s.replace(/^(\d)(\d{2})x/, "$1.$2x");
  // Three-digit caliber alone (like 338, 408): prepend a dot
  s = s.replace(/^(\d{3})([A-Z]|$)/, ".$1$2");
  // Split camelCase (MP-5 suffixes like NATO, PARA, LAPUA, ACP)
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return s.trim();
}

// Compact per-mod stat badges — green for helpful, red for costly, cyan/orange
// for neutral stats like capacity / malfunction / zoom. Shared by the mod picker
// overlay and the tree view so each slot shows what its installed mod actually
// contributes to the build.
function ModStats({ mod }) {
  if (!mod) return null;
  const mp = mod.properties;
  const ergo = mp?.ergonomics || 0;
  const recoil = mp?.recoilModifier || 0;
  const acc = mp?.accuracyModifier || 0;
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
      {ergo !== 0 && <span style={{ fontSize: T.fs1, color: ergo > 0 ? T.success : T.error }}>{ergo > 0 ? "+" : ""}{ergo} ergo</span>}
      {recoil !== 0 && <span style={{ fontSize: T.fs1, color: recoil < 0 ? T.success : T.error }}>{recoil > 0 ? "+" : ""}{Math.round(recoil * 100)}% recoil</span>}
      {acc !== 0 && <span style={{ fontSize: T.fs1, color: acc < 0 ? T.success : T.error }}>{acc > 0 ? "+" : ""}{Math.round(acc * 100)}% acc</span>}
      {mp?.capacity && <span style={{ fontSize: T.fs1, color: T.cyan }}>{mp.capacity} rnd</span>}
      {mp?.malfunctionChance != null && mp.malfunctionChance > 0 && <span style={{ fontSize: T.fs1, color: T.orange }}>{Math.round(mp.malfunctionChance * 100)}% malf</span>}
      {mp?.loadModifier != null && mp.loadModifier !== 0 && <span style={{ fontSize: T.fs1, color: mp.loadModifier < 0 ? T.success : T.error }}>{mp.loadModifier > 0 ? "+" : ""}{Math.round(mp.loadModifier * 100)}% load</span>}
      {mod.loudness != null && mod.loudness !== 0 && <span style={{ fontSize: T.fs1, color: mod.loudness < 0 ? T.success : T.error }}>{mod.loudness > 0 ? "+" : ""}{mod.loudness} loud</span>}
      {mod.velocity != null && mod.velocity !== 0 && <span style={{ fontSize: T.fs1, color: mod.velocity > 0 ? T.success : T.error }}>{mod.velocity > 0 ? "+" : ""}{Math.round(mod.velocity)} vel</span>}
      {mp?.zoomLevels?.length > 0 && <span style={{ fontSize: T.fs1, color: T.cyan }}>{mp.zoomLevels.join("/")}x</span>}
      {mp?.sightingRange > 0 && <span style={{ fontSize: T.fs1, color: T.cyan }}>{mp.sightingRange}m</span>}
      {mp?.deviationMax > 0 && <span style={{ fontSize: T.fs1, color: T.orange }}>{mp.deviationMax} dev</span>}
    </div>
  );
}

export default function BuildsTab({ savedBuilds, saveSavedBuilds, myProfile }) {
  const [weapons, setWeapons] = useState(null);
  const [weaponsLoading, setWeaponsLoading] = useState(false);
  const [screen, setScreen] = useState("list"); // "list" | "pick" | "edit" | "leaderboard"
  const [leaderboardCaliber, setLeaderboardCaliber] = useState(null); // exact caliber string, null = pick first available
  const [leaderboardMode, setLeaderboardMode] = useState("recoil-balanced"); // "ergo" | "recoil" | "recoil-balanced"
  const [leaderboardRows, setLeaderboardRows] = useState(null); // null while loading
  const [leaderboardProgress, setLeaderboardProgress] = useState({ loaded: 0, total: 0 });
  const [leaderboardAvailableOnly, setLeaderboardAvailableOnly] = useState(false);
  const weaponDetailCache = useRef({}); // { [weaponId]: { [gameMode]: detail } }
  const [selectedWeapon, setSelectedWeapon] = useState(null); // full weapon detail data
  const [weaponLoading, setWeaponLoading] = useState(false);
  const [mods, setMods] = useState({}); // { slotPath: modItemId }
  const [editingBuild, setEditingBuild] = useState(null); // build being edited
  const [pickerSlot, setPickerSlot] = useState(null); // slot currently picking for
  const [weaponSearch, setWeaponSearch] = useState("");
  const [weaponCategory, setWeaponCategory] = useState("all");
  const [buildName, setBuildName] = useState("");
  const [importCode, setImportCode] = useState("");
  const [importError, setImportError] = useState("");
  const { copied, copy } = useCopyToClipboard(); // `copied` = build id that was just copied
  const [gameMode, setGameMode] = useStorage("tg-builds-gamemode-v1", "pve"); // persists across tab switches
  const [modSort, setModSort] = useState("name"); // "name" | "price" | "ergo" | "recoil"
  const [modSearch, setModSearch] = useState(""); // search filter inside the mod picker
  // Per-build lock + custom-target state. Persisted with the saved build,
  // not in the share code. Default: empty locks, zero targets — preserves
  // legacy behavior (scope/sight/mag still implicitly skipped via the
  // optimizer's DEFAULT_SKIP regex).
  const [lockedPaths, setLockedPaths] = useState(new Set()); // Set<path>
  const [opMode, setOpMode] = useState("balanced"); // "ergo" | "recoil" | "balanced" | "custom"
  const [customTargets, setCustomTargets] = useState({ e: 0, r: 0 });
  const [maxStats, setMaxStats] = useState({ e: 0, r: 0 });
  // Pareto frontier of (E, R) points for the current weapon+locks. Used
  // by the CUSTOM-mode mini chart so the user can see the trade-off
  // curve their targets are sliding along.
  const [frontier, setFrontier] = useState([]);
  // Frontier cache keyed by weaponId + sorted lock paths. Avoids
  // recomputing the 5-point sweep when nothing relevant changed
  // (e.g. user toggling between modes, slider drags).
  const frontierCache = useRef(new Map());
  // Debounce slider drags so we don't run the optimizer on every pixel of movement.
  const debouncedTargets = useDebouncedValue(customTargets, 200);

  // Lazy load weapon list on first mount
  useEffect(() => {
    if (weapons || weaponsLoading) return;
    setWeaponsLoading(true);
    fetchAPI(WEAPONS_LIST_Q)
      .then(d => { if (d?.items) setWeapons(d.items.filter(i => i.properties?.caliber)); })
      .finally(() => setWeaponsLoading(false));
  }, []);

  // Re-fetch weapon detail when game mode changes (prices differ between PvE/PvP)
  useEffect(() => {
    if (!selectedWeapon) return;
    (async () => {
      try {
        const d = await fetchAPI(weaponDetailQ(selectedWeapon.id, gameMode));
        if (d?.item) setSelectedWeapon(d.item);
      } catch(e) {}
    })();
  }, [gameMode]);

  // Unique, sorted list of calibers present in the weapon DB.
  const calibers = useMemo(() => {
    if (!weapons) return [];
    const set = new Set();
    for (const w of weapons) {
      if (w.properties?.caliber) set.add(w.properties.caliber);
    }
    return Array.from(set).sort((a, b) => formatCaliber(a).localeCompare(formatCaliber(b)));
  }, [weapons]);

  // Pick the first caliber when none is selected yet (e.g. on first open).
  useEffect(() => {
    if (leaderboardCaliber == null && calibers.length > 0) {
      setLeaderboardCaliber(calibers[0]);
    }
  }, [calibers, leaderboardCaliber]);

  // The optimizer's internal recoil metric is "sum of recoilModifier × 100"
  // — a percentage that's weapon-agnostic. The user-facing slider, on the
  // other hand, is in raw V+H recoil reduction (matches the stats panel
  // and leaderboard's R column). These two helpers bridge the boundary.
  const baseRecoilSum = (w) =>
    (w?.properties?.recoilVertical || 0) + (w?.properties?.recoilHorizontal || 0);
  const pctToRaw = (pct, w) => {
    const base = baseRecoilSum(w);
    return base > 0 ? Math.round((pct * base) / 100) : 0;
  };
  const rawToPct = (raw, w) => {
    const base = baseRecoilSum(w);
    return base > 0 ? (raw * 100) / base : 0;
  };

  // Compute slider-range maximums (E_max, R_max) for the editor's CUSTOM
  // mode. "Max" is constrained by the user's locks — slider can't promise
  // values that aren't reachable given the locked picks.
  useEffect(() => {
    if (!selectedWeapon) return;
    const opts = { currentMods: mods, lockedPaths };
    try {
      const ergoMods = optimizeBuild(selectedWeapon, "ergo", opts);
      const recoilMods = optimizeBuild(selectedWeapon, "recoil", opts);
      setMaxStats({
        e: Math.round(computeTotalErgo(selectedWeapon, ergoMods)),
        r: pctToRaw(computeTotalRecoil(selectedWeapon, recoilMods), selectedWeapon),
      });
    } catch {
      // Optimizer is pure-function. If it throws, leave maxStats unchanged
      // so the CUSTOM sliders stay in their disabled "computing…" state.
    }
    // Intentionally exclude `mods` from deps — re-run only when the weapon
    // or the lock set changes. Manual mod edits shouldn't recompute the
    // theoretical max. lockedPaths reference identity changes when the user
    // toggles a lock, which is what triggers a recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWeapon?.id, lockedPaths, gameMode]);

  // CUSTOM mode auto-run: any change to debounced targets (or locks)
  // re-runs the dual-floor optimizer and overwrites `mods`. Manual mod
  // edits don't trigger this (mods isn't in deps).
  useEffect(() => {
    if (opMode !== "custom" || !selectedWeapon) return;
    try {
      // With both targets at 0 the CUSTOM B&B has nothing to constrain;
      // route through recoil-balanced (cached, instant) instead of
      // running a slow unconstrained search.
      if (!debouncedTargets.e && !debouncedTargets.r) {
        setMods(optimizeBuild(selectedWeapon, "recoil-balanced", {
          currentMods: mods,
          lockedPaths,
        }));
        return;
      }
      const newMods = optimizeBuild(selectedWeapon, "custom", {
        currentMods: mods,
        lockedPaths,
        ergoTarget: debouncedTargets.e,
        recoilTarget: rawToPct(debouncedTargets.r, selectedWeapon),
      });
      setMods(newMods);
    } catch {
      // Optimizer error — keep current mods. UI continues to function.
    }
    // opMode intentionally excluded: clicking CUSTOM in `runMode` runs the
    // optimizer directly, so this effect only handles slider/lock changes
    // *while already in* CUSTOM. Including opMode would double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedTargets.e, debouncedTargets.r, lockedPaths, selectedWeapon?.id]);

  // Pareto frontier compute. Cached per (weapon, locks). Each point is
  // computed in its own setTimeout tick so the UI thread is free
  // between optimizer runs — at worst the user sees brief stutters,
  // not a sustained freeze. Diagnostic timing is logged so a slow
  // weapon can be identified.
  useEffect(() => {
    if (opMode !== "custom" || !selectedWeapon) return;
    if (!maxStats.e) return;
    const cacheKey = `${selectedWeapon.id}|${[...lockedPaths].sort().join(",")}`;
    if (frontierCache.current.has(cacheKey)) {
      setFrontier(frontierCache.current.get(cacheKey));
      return;
    }
    setFrontier([]);
    let cancelled = false;
    let pendingTimer = null;
    const N = 3;
    const accumulated = [];
    const seen = new Set();

    const runStep = (i) => {
      if (cancelled || i > N) {
        if (!cancelled) {
          accumulated.sort((a, b) => a.e - b.e);
          frontierCache.current.set(cacheKey, accumulated);
          setFrontier(accumulated);
        }
        return;
      }
      const eFloor = Math.round((i / N) * maxStats.e);
      const t0 = Date.now();
      try {
        const result = optimizeBuild(selectedWeapon, "custom", {
          currentMods: mods,
          lockedPaths,
          ergoTarget: eFloor,
          recoilTarget: 0,
        });
        const dt = Date.now() - t0;
        if (dt > 500) {
          console.warn(`[frontier] step ${i}/${N} took ${dt}ms on ${selectedWeapon.shortName} (eFloor=${eFloor})`);
        }
        const e = Math.round(computeTotalErgo(selectedWeapon, result));
        const r = pctToRaw(computeTotalRecoil(selectedWeapon, result), selectedWeapon);
        const k = `${e},${r}`;
        if (!seen.has(k)) {
          seen.add(k);
          accumulated.push({ e, r });
          // Progressive UI update so the user sees the curve appear.
          setFrontier([...accumulated].sort((a, b) => a.e - b.e));
        }
      } catch (err) {
        console.warn("[frontier] step error", err);
      }
      // Yield between steps so click handlers / paints can run.
      pendingTimer = setTimeout(() => runStep(i + 1), 16);
    };

    // Initial delay before any compute, so the user can adjust sliders
    // for a moment without their input getting drowned out by an
    // unrelated background sweep.
    pendingTimer = setTimeout(() => runStep(0), 800);

    return () => {
      cancelled = true;
      if (pendingTimer) clearTimeout(pendingTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opMode, lockedPaths, selectedWeapon?.id, maxStats.e, maxStats.r]);

  // Leaderboard: fetch every weapon detail for the selected caliber in
  // parallel, optimize + compute stats, and commit the full row set in a
  // single state update. Atomic commit avoids a class of sort-order bugs
  // where progressively-pushed rows can race with React renders when the
  // mode or caliber changes mid-load.
  useEffect(() => {
    if (screen !== "leaderboard" || !weapons || !leaderboardCaliber) return;
    let cancelled = false;
    const filtered = weapons.filter((w) => w.properties?.caliber === leaderboardCaliber);
    setLeaderboardRows([]);
    setLeaderboardProgress({ loaded: 0, total: filtered.length });

    const loadOne = async (w) => {
      const cached = weaponDetailCache.current[w.id]?.[gameMode];
      if (cached) return cached;
      try {
        const d = await fetchAPI(weaponDetailQ(w.id, gameMode));
        const detail = d?.item || null;
        if (detail) {
          weaponDetailCache.current[w.id] = weaponDetailCache.current[w.id] || {};
          weaponDetailCache.current[w.id][gameMode] = detail;
        }
        return detail;
      } catch (_) {
        return null;
      }
    };

    const availPredicate = leaderboardAvailableOnly
      ? (item) => isAvailableForProfile(item, myProfile)
      : null;

    (async () => {
      let loaded = 0;
      const results = await Promise.all(filtered.map(async (w) => {
        const detail = await loadOne(w);
        loaded += 1;
        if (!cancelled) setLeaderboardProgress({ loaded, total: filtered.length });
        if (!detail) return null;
        // When the availability filter is on, drop weapons the user can't even buy.
        if (availPredicate && !availPredicate(detail)) return null;
        const mods = optimizeBuild(detail, leaderboardMode, { isAvailable: availPredicate });
        const stats = calcStats(detail, mods);
        return { weapon: detail, mods, stats };
      }));
      if (cancelled) return;
      setLeaderboardRows(results.filter(Boolean));
    })();

    return () => { cancelled = true; };
  }, [screen, leaderboardCaliber, leaderboardMode, gameMode, weapons, leaderboardAvailableOnly, myProfile]);

  // Load full weapon detail when picking a weapon
  const selectWeapon = async (weaponId) => {
    setWeaponLoading(true);
    try {
      const d = await fetchAPI(weaponDetailQ(weaponId, gameMode));
      if (d?.item) {
        setSelectedWeapon(d.item);
        setMods({});
        setLockedPaths(new Set());
        setCustomTargets({ e: 0, r: 0 });
        setOpMode("balanced");
        setBuildName("");
        setScreen("edit");
      }
    } catch(e) {}
    setWeaponLoading(false);
  };

  // Load a saved build into the editor
  const loadBuild = async (build) => {
    setWeaponLoading(true);
    setEditingBuild(build);
    try {
      const d = await fetchAPI(weaponDetailQ(build.weaponId, gameMode));
      if (d?.item) {
        setSelectedWeapon(d.item);
        setMods(build.mods || {});
        setLockedPaths(new Set(build.lockedPaths || []));
        setCustomTargets(build.customTargets || { e: 0, r: 0 });
        setOpMode("balanced");
        setBuildName(build.name || "");
        setScreen("edit");
      }
    } catch(e) {}
    setWeaponLoading(false);
  };

  // Helper: format ruble price
  const fmtPrice = (rub) => {
    if (!rub) return "—";
    return rub >= 1000 ? Math.round(rub / 1000) + "k ₽" : rub + " ₽";
  };

  // Save current build
  const saveBuild = () => {
    const build = {
      id: editingBuild?.id || "bld_" + Date.now(),
      name: buildName || selectedWeapon?.shortName + " Build",
      weaponId: selectedWeapon.id,
      mods: { ...mods },
      lockedPaths: [...lockedPaths],
      customTargets: { ...customTargets },
      createdAt: editingBuild?.createdAt || Date.now(),
    };
    const existing = savedBuilds.findIndex(b => b.id === build.id);
    if (existing >= 0) {
      const updated = [...savedBuilds];
      updated[existing] = build;
      saveSavedBuilds(updated);
    } else {
      saveSavedBuilds([build, ...savedBuilds]);
    }
    setEditingBuild(null);
    setScreen("list");
  };

  const deleteBuild = (id) => {
    if (window.confirm("Delete this build?")) saveSavedBuilds(savedBuilds.filter(b => b.id !== id));
  };

  const copyBuildCode = (build) => {
    const code = encodeBuild(build);
    if (!code) return;
    copy(code, build.id);
  };

  const importBuild = () => {
    setImportError("");
    const build = decodeBuild(importCode.trim());
    if (!build) { setImportError("Invalid build code."); return; }
    saveSavedBuilds([build, ...savedBuilds]);
    setImportCode("");
  };

  // Weapon categories from caliber
  const getCategory = (caliber) => {
    if (!caliber) return "other";
    const c = caliber.toLowerCase();
    if (c.includes("12g") || c.includes("20g") || c.includes("23x75")) return "shotgun";
    if (c.includes("9x18") || c.includes("9x19") || c.includes("9x21") || c.includes("7.62x25") || c.includes("46x30") || c.includes("57x28")) return "smg";
    if (c.includes("338") || c.includes("408") || c.includes("762x54") || c.includes("86x70")) return "sniper";
    if (c.includes("9x33") || c.includes("1143x23") || c.includes("357")) return "pistol";
    return "assault";
  };

  const categories = ["all", "assault", "smg", "sniper", "shotgun", "pistol"];

  // ─── RENDER: MOD PICKER OVERLAY ───
  if (pickerSlot) {
    const { slot, path } = pickerSlot;
    const items = slot.filters?.allowedItems || [];
    const currentModId = mods[path];

    // Build the set of currently-installed mod IDs (across the whole
    // build) so we can mark items in the picker that conflict with
    // them. The user wouldn't be able to install a conflicting item
    // without first removing the conflicting one — surfacing this
    // upfront saves a round-trip.
    const installedIds = new Set(Object.values(mods));
    const conflictsFor = (item) => {
      const cis = item.conflictingItems;
      if (!cis) return null;
      for (const c of cis) {
        if (c.id === currentModId) continue; // installed in THIS slot doesn't count
        if (installedIds.has(c.id)) {
          // Find the conflicting mod's display name by searching all
          // allowedItems lists in the weapon's slot tree.
          let name = "another installed mod";
          const findName = (slots, prefix) => {
            for (const s of slots || []) {
              for (const it of s.filters?.allowedItems || []) {
                if (it.id === c.id) name = it.shortName || it.name;
                if (it.properties?.slots) findName(it.properties.slots, "");
              }
            }
          };
          findName(selectedWeapon?.properties?.slots, "");
          return name;
        }
      }
      return null;
    };

    const search = modSearch.trim().toLowerCase();
    const filteredItems = search
      ? items.filter((it) =>
          (it.name || "").toLowerCase().includes(search)
          || (it.shortName || "").toLowerCase().includes(search)
        )
      : items;
    const sortedItems = [...filteredItems].sort((a, b) => {
      if (modSort === "price") {
        const pa = getCheapestPrice(a)?.priceRUB || Infinity;
        const pb = getCheapestPrice(b)?.priceRUB || Infinity;
        return pa - pb;
      }
      if (modSort === "ergo") return (b.properties?.ergonomics || 0) - (a.properties?.ergonomics || 0);
      if (modSort === "recoil") return (a.properties?.recoilModifier || 0) - (b.properties?.recoilModifier || 0);
      return a.name.localeCompare(b.name);
    });
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <button onClick={() => { setPickerSlot(null); setModSearch(""); }} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, padding: 0 }}>← BACK</button>
            <div style={{ fontSize: T.fs2, color: T.textDim }}>{filteredItems.length}{search ? ` of ${items.length}` : ""} options</div>
          </div>
          <div style={{ fontSize: T.fs4, color: T.gold, fontWeight: "bold", letterSpacing: 1, marginBottom: 8 }}>{slot.name.toUpperCase()}</div>
          <input
            value={modSearch}
            onChange={(e) => setModSearch(e.target.value)}
            placeholder="Search mods..."
            style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "6px 10px", fontSize: T.fs2, fontFamily: T.sans, outline: "none", boxSizing: "border-box", marginBottom: 8 }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {["name", "price", "ergo", "recoil"].map(s => (
              <button key={s} onClick={() => setModSort(s)} style={{ flex: 1, background: modSort === s ? T.gold + "22" : "transparent", border: `1px solid ${modSort === s ? T.gold : T.border}`, color: modSort === s ? T.gold : T.textDim, padding: "4px 0", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5, textTransform: "uppercase" }}>{s}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {!slot.required && (
            <button onClick={() => { const next = { ...mods }; delete next[path]; setMods(next); setPickerSlot(null); setModSearch(""); }} style={{ width: "100%", background: T.errorBg, border: `1px solid ${T.errorBorder}`, color: T.error, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, marginBottom: 10 }}>✕ CLEAR SLOT</button>
          )}
          {sortedItems.length === 0 && (
            <div style={{ color: T.textDim, fontSize: T.fs2, textAlign: "center", padding: 20 }}>
              No mods match "{modSearch}".
            </div>
          )}
          {sortedItems.map(item => {
            const isSelected = currentModId === item.id;
            const cheapest = getCheapestPrice(item);
            const conflictName = conflictsFor(item);
            return (
              <button key={item.id} onClick={() => { setMods({ ...mods, [path]: item.id }); setPickerSlot(null); setModSearch(""); }}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: isSelected ? T.gold + "22" : T.surface, border: `1px solid ${isSelected ? T.gold : T.border}`, borderLeft: `2px solid ${isSelected ? T.gold : "transparent"}`, padding: 10, marginBottom: 4, cursor: "pointer", textAlign: "left" }}>
                {item.gridImageLink && <img src={item.gridImageLink} alt="" style={{ width: 48, height: 48, objectFit: "contain", background: T.inputBg, border: `1px solid ${T.border}`, flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: isSelected ? T.gold : T.textBright, fontSize: T.fs2, fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.shortName || item.name}</span>
                    {cheapest && <span style={{ fontSize: T.fs1, color: T.gold, whiteSpace: "nowrap", flexShrink: 0 }}>{fmtPrice(cheapest.priceRUB)}</span>}
                  </div>
                  {cheapest?.vendor && <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 1 }}>{cheapest.vendor.name}{cheapest.vendor.minTraderLevel ? " LL" + cheapest.vendor.minTraderLevel : ""}</div>}
                  {conflictName && (
                    <div style={{ fontSize: T.fs1, color: T.error, marginTop: 2, fontWeight: "bold" }}>
                      ⚠ Conflicts with installed {conflictName}
                    </div>
                  )}
                  <ModStats mod={item} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── RENDER: WEAPON PICKER ───
  if (screen === "pick") {
    const filtered = (weapons || []).filter(w => {
      if (weaponCategory !== "all" && getCategory(w.properties?.caliber) !== weaponCategory) return false;
      if (weaponSearch && !w.name.toLowerCase().includes(weaponSearch.toLowerCase()) && !w.shortName?.toLowerCase().includes(weaponSearch.toLowerCase())) return false;
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name));

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <button onClick={() => setScreen("list")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, padding: 0 }}>← BACK</button>
            <div style={{ fontSize: T.fs2, color: T.textDim }}>{filtered.length} weapons</div>
          </div>
          <input value={weaponSearch} onChange={e => setWeaponSearch(e.target.value)} placeholder="Search weapons..." style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "7px 10px", fontSize: T.fs2, fontFamily: T.sans, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {categories.map(c => <Btn key={c} ch={c} compact active={weaponCategory === c} onClick={() => setWeaponCategory(c)} />)}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {weaponsLoading && <div style={{ color: T.textDim, fontSize: T.fs3, textAlign: "center", padding: 20 }}>Loading weapons from tarkov.dev...</div>}
          {weaponLoading && <div style={{ color: T.gold, fontSize: T.fs3, textAlign: "center", padding: 20 }}>Loading weapon details...</div>}
          {!weaponsLoading && !weaponLoading && filtered.map(w => {
            const wp = w.properties;
            return (
              <button key={w.id} onClick={() => selectWeapon(w.id)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}33`, padding: 10, marginBottom: 6, cursor: "pointer", textAlign: "left" }}>
                {w.gridImageLink && <img src={w.gridImageLink} alt="" style={{ width: 64, height: 32, objectFit: "contain", background: T.inputBg, border: `1px solid ${T.border}`, flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: T.textBright, fontSize: T.fs2, fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.shortName || w.name}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
                    <span style={{ fontSize: T.fs1, color: T.textDim }}>{wp?.caliber?.replace("Caliber","").replace(/([a-z])([A-Z])/g,"$1 $2") || "?"}</span>
                    <span style={{ fontSize: T.fs1, color: T.cyan }}>E{wp?.ergonomics || 0}</span>
                    <span style={{ fontSize: T.fs1, color: T.orange }}>R{wp?.recoilVertical || 0}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── RENDER: BUILD EDITOR ───
  if (screen === "edit" && selectedWeapon) {
    const wp = selectedWeapon.properties;
    const stats = calcStats(selectedWeapon, mods);
    const baseErgo = wp.ergonomics || 0;
    const baseRecoilV = wp.recoilVertical || 0;
    const baseRecoilH = wp.recoilHorizontal || 0;

    // Stat cell helper
    const StatCell = ({ label, value, color, sub }) => (
      <div style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.border}`, padding: "5px 6px", textAlign: "center", minWidth: 0 }}>
        <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        <div style={{ fontSize: T.fs3, fontWeight: "bold", color: color || T.textBright, whiteSpace: "nowrap" }}>{value}</div>
        {sub && <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 1 }}>{sub}</div>}
      </div>
    );

    // Mode buttons run the optimizer immediately on click. CUSTOM also
    // runs once with the current slider targets; subsequent slider/lock
    // changes are picked up by the auto-run effect (debouncedTargets dep).
    const runMode = (mode) => {
      setOpMode(mode);
      const opts = { currentMods: mods, lockedPaths };
      if (mode === "custom") {
        // With both targets at 0 the CUSTOM B&B is unconstrained and
        // can be slow on conflict-heavy weapons. The recoil-balanced
        // result is essentially the same answer (max R+E with a soft
        // ergo target) and hits the precomputed cache for free, so
        // route through it. Slider changes will trigger the proper
        // CUSTOM B&B via the auto-run effect once targets are non-zero.
        if (!customTargets.e && !customTargets.r) {
          setMods(optimizeBuild(selectedWeapon, "recoil-balanced", opts));
          return;
        }
        opts.ergoTarget = customTargets.e;
        // Convert raw V+H reduction (UI units) → recoilModifier-percentage (optimizer units).
        opts.recoilTarget = rawToPct(customTargets.r, selectedWeapon);
        setMods(optimizeBuild(selectedWeapon, "custom", opts));
        return;
      }
      const apiMode = mode === "balanced" ? "recoil-balanced" : mode;
      setMods(optimizeBuild(selectedWeapon, apiMode, opts));
    };

    const toggleLock = (path) => {
      setLockedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    };

    const resetAllMods = () => {
      if (!window.confirm("Clear all mods and locks for this build?")) return;
      setMods({});
      setLockedPaths(new Set());
      setCustomTargets({ e: 0, r: 0 });
      // Exit CUSTOM so the auto-run effect doesn't immediately re-fill
      // mods with an unconstrained max-sum build.
      setOpMode("balanced");
    };

    // Single-slot swap suggestions: for each currently-installed mod on
    // a non-locked path, find the best compatible alternative whose
    // (ergo + recoil-ctrl) score beats the current pick. Top 5 by gain
    // are surfaced below the assembly so the user can fine-tune one
    // slot at a time without re-running a full optimization.
    const swapSuggestions = (() => {
      if (!selectedWeapon) return [];
      const out = [];
      const installedIds = new Set(Object.values(mods));
      const score = (mp) => (mp?.ergonomics || 0) + (-(mp?.recoilModifier || 0)) * 100;
      const walk = (slots, prefix) => {
        for (const slot of slots || []) {
          const path = prefix ? `${prefix}.${slot.nameId}` : slot.nameId;
          const currentId = mods[path];
          if (currentId) {
            const skipImplicit = IMPLICIT_SKIP_RX.test(slot.nameId);
            const isFrozen = lockedPaths.has(path) || skipImplicit;
            const currentMod = slot.filters?.allowedItems?.find((i) => i.id === currentId);
            if (currentMod && !isFrozen) {
              const curScore = score(currentMod.properties);
              let best = null;
              for (const alt of slot.filters?.allowedItems || []) {
                if (alt.id === currentId) continue;
                let conflicts = false;
                for (const c of alt.conflictingItems || []) {
                  if (c.id === currentId) continue;
                  if (installedIds.has(c.id)) { conflicts = true; break; }
                }
                if (conflicts) continue;
                const altScore = score(alt.properties);
                const delta = altScore - curScore;
                if (delta > 0 && (!best || delta > best.delta)) {
                  best = { alt, delta };
                }
              }
              if (best) {
                const ce = currentMod.properties?.ergonomics || 0;
                const ne = best.alt.properties?.ergonomics || 0;
                const cr = -(currentMod.properties?.recoilModifier || 0) * 100;
                const nr = -(best.alt.properties?.recoilModifier || 0) * 100;
                out.push({
                  path,
                  slotName: slot.name,
                  fromMod: currentMod,
                  toMod: best.alt,
                  eDelta: Math.round(ne - ce),
                  rDelta: Math.round(nr - cr),
                  combined: best.delta,
                });
              }
            }
            // Recurse into the installed mod's sub-slots regardless of
            // whether this slot suggested a swap.
            if (currentMod?.properties?.slots) walk(currentMod.properties.slots, path);
          }
        }
      };
      walk(wp.slots, "");
      return out.sort((a, b) => b.combined - a.combined).slice(0, 5);
    })();

    const applySwap = (path, modId) => {
      setMods((prev) => ({ ...prev, [path]: modId }));
    };

    // Recursive slot renderer — visual assembly cards. Each card shows
    // its mod, price, and a lock toggle. The toggle is informational
    // (greyed out) for slots already implicitly preserved by the
    // optimizer's DEFAULT_SKIP regex (scope/sight/magazine).
    const renderSlot = (slot, pathPrefix, depth = 0) => {
      const path = pathPrefix ? `${pathPrefix}.${slot.nameId}` : slot.nameId;
      const modId = mods[path];
      const mod = modId ? slot.filters?.allowedItems?.find(i => i.id === modId) : null;
      const hasOptions = (slot.filters?.allowedItems?.length || 0) > 0;
      const modPrice = mod ? getCheapestPrice(mod) : null;
      const isSubSlot = depth > 0;
      const implicitlySkipped = IMPLICIT_SKIP_RX.test(slot.nameId);
      const isLocked = lockedPaths.has(path) || implicitlySkipped;
      const lockBorder = isLocked ? T.cyan : (mod ? T.success : slot.required ? T.gold : T.border);

      return (
        <div key={path} style={{ marginLeft: isSubSlot ? 20 : 0, position: "relative" }}>
          {isSubSlot && <div style={{ position: "absolute", left: -12, top: 0, bottom: 0, width: 1, background: T.border }} />}
          {isSubSlot && <div style={{ position: "absolute", left: -12, top: 24, width: 12, height: 1, background: T.border }} />}
          <div style={{ display: "flex", alignItems: "stretch", gap: 4, marginBottom: 5 }}>
            <button onClick={() => hasOptions && setPickerSlot({ slot, path })}
              style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, background: mod ? T.surface : "transparent", border: `1px solid ${mod ? T.border : slot.required ? T.gold + "55" : T.border + "88"}`, borderLeft: `3px solid ${lockBorder}`, padding: mod ? "8px 10px" : "10px", cursor: hasOptions ? "pointer" : "default", textAlign: "left", opacity: hasOptions ? 1 : 0.4 }}>
              {mod?.gridImageLink ? (
                <img src={mod.gridImageLink} alt="" style={{ width: 56, height: 42, objectFit: "contain", background: T.inputBg, border: `1px solid ${T.border}`, flexShrink: 0 }} />
              ) : (
                <div style={{ width: 56, height: 42, border: `2px dashed ${slot.required ? T.gold + "55" : T.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ fontSize: 16, color: slot.required ? T.gold + "66" : T.textDim + "44" }}>+</span>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: T.fs1, color: mod ? T.textDim : (slot.required ? T.gold : T.textDim), letterSpacing: 0.8 }}>{slot.name.toUpperCase()}{slot.required ? " *" : ""}</span>
                  {isLocked && <span style={{ fontSize: T.fs1, color: T.cyan, letterSpacing: 0.8, fontWeight: "bold" }}>{implicitlySkipped ? "AUTO" : "LOCKED"}</span>}
                </div>
                {mod ? (
                  <>
                    <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mod.shortName || mod.name}</div>
                    <ModStats mod={mod} />
                  </>
                ) : (
                  <div style={{ fontSize: T.fs2, color: T.textDim, fontStyle: "italic" }}>{hasOptions ? "Tap to add" : "No options"}</div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, gap: 2 }}>
                {modPrice && <span style={{ fontSize: T.fs1, color: T.gold }}>{fmtPrice(modPrice.priceRUB)}</span>}
                {modPrice?.vendor && <span style={{ fontSize: T.fs1, color: T.textDim }}>{modPrice.vendor.name === "Flea Market" ? "Flea" : modPrice.vendor.name}{modPrice.vendor.minTraderLevel ? " LL" + modPrice.vendor.minTraderLevel : ""}</span>}
                {!mod && hasOptions && <span style={{ color: T.textDim, fontSize: T.fs3 }}>▶</span>}
              </div>
            </button>
            {/* Lock toggle. Implicit-skip slots show a non-clickable
                indicator since they're already preserved by the optimizer. */}
            {hasOptions && (
              <button
                onClick={(e) => { e.stopPropagation(); if (!implicitlySkipped) toggleLock(path); }}
                title={implicitlySkipped ? "Optics, sights, and magazines are preserved automatically" : (isLocked ? "Locked — click to unlock" : "Unlocked — click to lock")}
                style={{
                  width: 28,
                  background: isLocked ? T.cyan + "22" : "transparent",
                  border: `1px solid ${isLocked ? T.cyan + "66" : T.border}`,
                  color: isLocked ? T.cyan : T.textDim,
                  cursor: implicitlySkipped ? "not-allowed" : "pointer",
                  fontFamily: T.sans,
                  fontSize: T.fs3,
                  flexShrink: 0,
                  opacity: implicitlySkipped ? 0.5 : 1,
                }}
              >{isLocked ? "🔒" : "🔓"}</button>
            )}
          </div>
          {mod?.properties?.slots && mod.properties.slots.map(subSlot => renderSlot(subSlot, path, depth + 1))}
        </div>
      );
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* Top header bar — navigation + persistent toggles + save. */}
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
          <button onClick={() => { setScreen("list"); setSelectedWeapon(null); setEditingBuild(null); }} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, padding: 0, flexShrink: 0 }}>← BACK</button>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={resetAllMods} title="Clear all mods and locks" style={{ background: T.errorBg, border: `1px solid ${T.errorBorder}`, color: T.error, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>RESET</button>
            <button onClick={() => { const next = gameMode === "pve" ? "regular" : "pve"; setGameMode(next); }} style={{ background: gameMode === "pve" ? T.cyan + "22" : T.orange + "22", border: `1px solid ${gameMode === "pve" ? T.cyan + "44" : T.orange + "44"}`, color: gameMode === "pve" ? T.cyan : T.orange, padding: "4px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 0.5 }}>{gameMode === "pve" ? "PVE" : "PVP"}</button>
            <button onClick={saveBuild} style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "6px 12px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>SAVE</button>
          </div>
        </div>
        {/* Mode selector row. Click runs the optimizer in the chosen
            mode; CUSTOM additionally exposes two target sliders. */}
        <div style={{ background: T.bg, borderBottom: `1px solid ${T.border}`, padding: "6px 14px", display: "flex", alignItems: "center", gap: 6 }}>
          <Tip text="ERGO: maximize ergonomics. RECOIL: minimize recoil at any cost. BAL: best recoil while keeping ergo at half the achievable max. CUSTOM: set your own ergo and recoil floors. All four respect locked slots and item-conflict rules. Lock individual slots with the lock icon to keep your picks (e.g. preferred stock, foregrip)." />
          {[
            { id: "ergo",     label: "ERGO",   color: T.cyan },
            { id: "recoil",   label: "RECOIL", color: T.orange },
            { id: "balanced", label: "BAL",    color: T.gold },
            { id: "custom",   label: "CUSTOM", color: T.purple },
          ].map((m) => {
            const active = opMode === m.id;
            return (
              <button key={m.id} onClick={() => runMode(m.id)}
                style={{
                  flex: 1,
                  background: active ? m.color + "33" : "transparent",
                  border: `1px solid ${active ? m.color : T.border}`,
                  color: active ? m.color : T.textDim,
                  padding: "5px 0",
                  fontSize: T.fs1,
                  cursor: "pointer",
                  fontFamily: T.sans,
                  letterSpacing: 0.8,
                  fontWeight: active ? "bold" : "normal",
                }}
              >{m.label}</button>
            );
          })}
        </div>
        {/* CUSTOM mode panel — two sliders + feasibility status. Only
            renders when CUSTOM is active so it doesn't clutter the
            other modes. The auto-run effect picks up slider changes
            after a 200ms debounce. */}
        {opMode === "custom" && (() => {
          const currentE = Math.round(computeTotalErgo(selectedWeapon, mods));
          // currentR shown in raw V+H reduction (matches stats panel
          // and slider scale). Optimizer's internal pct gets converted.
          const currentR = pctToRaw(computeTotalRecoil(selectedWeapon, mods), selectedWeapon);
          const eFeasible = currentE >= customTargets.e;
          const rFeasible = currentR >= customTargets.r;
          const feasible = eFeasible && rFeasible;
          const eMax = maxStats.e || 1;
          const rMax = maxStats.r || 1;
          const ready = maxStats.e > 0 || maxStats.r > 0;
          return (
            <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>CUSTOM TARGETS{!ready && " — computing max…"}</span>
                <span style={{ fontSize: T.fs1, color: feasible ? T.success : T.gold, fontWeight: "bold", letterSpacing: 0.5 }}>
                  {feasible ? "✓ FEASIBLE" : (!eFeasible && !rFeasible ? "⚠ BOTH UNMET" : !eFeasible ? "⚠ ERGO UNMET" : "⚠ RECOIL UNMET")}
                </span>
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: T.fs1, color: T.textDim, marginBottom: 2 }}>
                  <span style={{ color: T.cyan }}>ERGO TARGET</span>
                  <span>
                    {customTargets.e} / {maxStats.e || "?"}
                    <span style={{ color: eFeasible ? T.success : T.error, marginLeft: 8 }}>now {currentE}</span>
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={eMax}
                  value={Math.min(customTargets.e, eMax)}
                  disabled={!ready}
                  onChange={(ev) => setCustomTargets((p) => ({ ...p, e: Number(ev.target.value) }))}
                  style={{ width: "100%", accentColor: T.cyan }}
                />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: T.fs1, color: T.textDim, marginBottom: 2 }}>
                  <span style={{ color: T.orange }}>RECOIL REDUCTION ↕↔ <Tip text="Combined vertical + horizontal recoil reduction in raw stat units — same scale as REC ↕ and REC ↔ in the stats panel. Slider max equals the raw V+H amount OPT RECOIL achieves on this weapon. Higher = stronger recoil control." /></span>
                  <span>
                    {customTargets.r} / {maxStats.r || "?"}
                    <span style={{ color: rFeasible ? T.success : T.error, marginLeft: 8 }}>now {currentR}</span>
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={rMax}
                  value={Math.min(customTargets.r, rMax)}
                  disabled={!ready}
                  onChange={(ev) => setCustomTargets((p) => ({ ...p, r: Number(ev.target.value) }))}
                  style={{ width: "100%", accentColor: T.orange }}
                />
              </div>
              {/* Pareto frontier mini-chart. Shows the achievable (E, R)
                  trade-off curve for this weapon and the user's current
                  target as a crosshair. Helps users see at a glance which
                  combinations are reachable. */}
              {frontier.length >= 2 && (() => {
                const xMax = Math.max(maxStats.e || 1, ...frontier.map((p) => p.e));
                const yMax = Math.max(maxStats.r || 1, ...frontier.map((p) => p.r));
                const xPx = (e) => (e / xMax) * 100;
                const yPx = (r) => 50 - (r / yMax) * 48;
                const targetX = xPx(customTargets.e);
                const targetY = yPx(customTargets.r);
                const buildX = xPx(currentE);
                const buildY = yPx(currentR);
                return (
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: T.fs1, color: T.textDim, marginBottom: 4, letterSpacing: 0.8 }}>
                      <span>FRONTIER</span>
                      <span style={{ color: T.textDim }}>x: ergo · y: recoil ctrl</span>
                    </div>
                    <svg viewBox="0 0 100 50" preserveAspectRatio="none" style={{ width: "100%", height: 60, background: T.inputBg, border: `1px solid ${T.border}` }}>
                      {/* Frontier polyline */}
                      <polyline
                        points={frontier.map((p) => `${xPx(p.e)},${yPx(p.r)}`).join(" ")}
                        fill="none"
                        stroke={T.gold}
                        strokeWidth="0.5"
                        opacity="0.6"
                      />
                      {/* Frontier points */}
                      {frontier.map((p, idx) => (
                        <circle key={idx} cx={xPx(p.e)} cy={yPx(p.r)} r="0.8" fill={T.gold} opacity="0.8" />
                      ))}
                      {/* User's target as a crosshair */}
                      <line x1={targetX} y1="0" x2={targetX} y2="50" stroke={feasible ? T.success : T.error} strokeWidth="0.3" strokeDasharray="1,1" opacity="0.5" />
                      <line x1="0" y1={targetY} x2="100" y2={targetY} stroke={feasible ? T.success : T.error} strokeWidth="0.3" strokeDasharray="1,1" opacity="0.5" />
                      {/* Current build position */}
                      <circle cx={buildX} cy={buildY} r="1.5" fill={feasible ? T.success : T.error} stroke={T.bg} strokeWidth="0.3" />
                    </svg>
                  </div>
                );
              })()}
            </div>
          );
        })()}
        {/* Scrollable content — everything flows together */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* Weapon Hero Image */}
          <div style={{ position: "relative" }}>
            <div style={{ background: `radial-gradient(ellipse at center, ${T.surface} 0%, ${T.bg} 100%)`, borderBottom: `1px solid ${T.border}`, padding: "20px 14px 12px", textAlign: "center" }}>
              {selectedWeapon.image512pxLink && <img src={selectedWeapon.image512pxLink} alt="" style={{ width: "100%", maxWidth: 460, height: "auto", objectFit: "contain", filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.5))" }} />}
            </div>
            <div style={{ textAlign: "center", padding: "8px 14px 0" }}>
              <div style={{ fontSize: T.fs5, color: T.gold, fontWeight: "bold", letterSpacing: 1 }}>{selectedWeapon.shortName || selectedWeapon.name}</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 4 }}>
                <span style={{ fontSize: T.fs2, color: T.textDim }}>{wp?.caliber?.replace("Caliber","").replace(/([a-z])([A-Z])/g,"$1 $2")}</span>
                <span style={{ fontSize: T.fs2, color: T.gold }}>{stats.fireModes.map(m => m.replace("SingleFire","SEMI").replace("FullAuto","AUTO").replace("Burst","BURST")).join(" / ")}</span>
              </div>
            </div>
            {/* Total cost badge */}
            {stats.totalCost > 0 && <div style={{ position: "absolute", top: 10, right: 14, background: T.gold + "22", border: `1px solid ${T.gold}44`, padding: "4px 10px", textAlign: "right" }}>
              <div style={{ fontSize: T.fs3, fontWeight: "bold", color: T.gold }}>{fmtPrice(stats.totalCost)}</div>
              <div style={{ fontSize: T.fs1, color: T.textDim }}>{stats.modCount} mods</div>
            </div>}
          </div>
          {/* Build name */}
          <div style={{ padding: "10px 14px 0" }}>
            <input value={buildName} onChange={e => setBuildName(e.target.value)} placeholder="Build name..." style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.sans, outline: "none", boxSizing: "border-box" }} />
          </div>
          {/* Stats panels */}
          <div style={{ padding: "10px 14px" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <StatCell label="ERGO" value={stats.ergo} color={stats.ergo > baseErgo ? T.success : stats.ergo < baseErgo ? T.error : T.textBright} />
              <StatCell label="REC ↕" value={stats.recoilV} color={stats.recoilV < baseRecoilV ? T.success : stats.recoilV > baseRecoilV ? T.error : T.textBright} />
              <StatCell label="REC ↔" value={stats.recoilH} color={stats.recoilH < baseRecoilH ? T.success : stats.recoilH > baseRecoilH ? T.error : T.textBright} />
              <StatCell label="ACC" value={stats.accMod === 0 ? "—" : (stats.accMod > 0 ? "+" : "") + stats.accMod + "%"} color={stats.accMod < 0 ? T.success : stats.accMod > 0 ? T.error : T.textDim} />
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <StatCell label="RPM" value={stats.fireRate || "—"} />
              <StatCell label="MAG" value={stats.magCapacity ? stats.magCapacity + "rnd" : "—"} color={stats.magCapacity ? T.cyan : T.textDim} />
              <StatCell label="WEIGHT" value={stats.weight + "kg"} />
              <StatCell label="EFF RNG" value={stats.effectiveDist ? stats.effectiveDist + "m" : "—"} color={stats.effectiveDist ? T.cyan : T.textDim} />
            </div>
            {(stats.loudness !== 0 || stats.velocity !== 0 || stats.malfChance > 0 || stats.loadMod !== 0 || stats.zoomLevels.length > 0) && (
              <div style={{ display: "flex", gap: 4 }}>
                {stats.loudness !== 0 && <StatCell label="LOUD" value={(stats.loudness > 0 ? "+" : "") + stats.loudness} color={stats.loudness < 0 ? T.success : T.error} />}
                {stats.velocity !== 0 && <StatCell label="VELOCITY" value={(stats.velocity > 0 ? "+" : "") + stats.velocity} color={stats.velocity > 0 ? T.success : T.error} />}
                {stats.malfChance > 0 && <StatCell label="MALF" value={stats.malfChance + "%"} color={T.orange} />}
                {stats.loadMod !== 0 && <StatCell label="LOAD SPD" value={(stats.loadMod > 0 ? "+" : "") + stats.loadMod + "%"} color={stats.loadMod < 0 ? T.success : T.error} />}
                {stats.zoomLevels.length > 0 && <StatCell label="OPTIC" value={stats.zoomLevels.join("/") + "x"} color={T.cyan} sub={stats.sightingRange ? stats.sightingRange + "m" : null} />}
              </div>
            )}
          </div>
          {/* Assembly — split into REQUIRED and OPTIONAL */}
          {(() => {
            // Collect all top-level slots with their fill status
            const allSlots = wp.slots || [];
            const requiredSlots = allSlots.filter(s => s.required);
            const optionalSlots = allSlots.filter(s => !s.required);
            const requiredFilled = requiredSlots.filter(s => mods[s.nameId]);
            const optionalFilled = optionalSlots.filter(s => mods[s.nameId]);
            const allRequiredDone = requiredFilled.length === requiredSlots.length;

            return (
              <div style={{ padding: "0 14px 20px" }}>
                {/* Build readiness banner */}
                <div style={{ background: allRequiredDone ? T.successBg : T.gold + "11", border: `1px solid ${allRequiredDone ? T.successBorder : T.gold + "44"}`, padding: "8px 12px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 18, flexShrink: 0 }}>{allRequiredDone ? "✓" : "⚠"}</div>
                  <div>
                    <div style={{ fontSize: T.fs2, color: allRequiredDone ? T.success : T.gold, fontWeight: "bold" }}>
                      {allRequiredDone ? "BUILD FUNCTIONAL" : `${requiredFilled.length}/${requiredSlots.length} REQUIRED PARTS`}
                    </div>
                    <div style={{ fontSize: T.fs1, color: T.textDim }}>
                      {allRequiredDone
                        ? `All required parts installed${optionalSlots.length ? ` — ${optionalFilled.length}/${optionalSlots.length} optional upgrades` : ""}`
                        : `${requiredSlots.length - requiredFilled.length} part${requiredSlots.length - requiredFilled.length > 1 ? "s" : ""} still needed to function in raid`}
                    </div>
                  </div>
                </div>

                {/* REQUIRED section */}
                {requiredSlots.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: T.fs2, color: T.gold, letterSpacing: 1.5, marginBottom: 8, paddingBottom: 4, borderBottom: `1px solid ${T.gold}44`, fontFamily: T.sans, display: "flex", alignItems: "center", gap: 8 }}>
                      REQUIRED
                      <span style={{ fontSize: T.fs1, color: allRequiredDone ? T.success : T.textDim, fontWeight: "normal", letterSpacing: 0 }}>{requiredFilled.length}/{requiredSlots.length}</span>
                    </div>
                    {requiredSlots.map(slot => renderSlot(slot, "", 0))}
                  </div>
                )}

                {/* OPTIONAL section */}
                {optionalSlots.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1.5, marginBottom: 8, paddingBottom: 4, borderBottom: `1px solid ${T.border}`, fontFamily: T.sans, display: "flex", alignItems: "center", gap: 8 }}>
                      OPTIONAL UPGRADES
                      {optionalFilled.length > 0 && <span style={{ fontSize: T.fs1, color: T.cyan, fontWeight: "normal", letterSpacing: 0 }}>{optionalFilled.length}/{optionalSlots.length}</span>}
                    </div>
                    {optionalSlots.map(slot => renderSlot(slot, "", 0))}
                  </div>
                )}
              </div>
            );
          })()}
          {/* Suggested swaps — single-slot fine-tuning. Skipped/locked
              slots are filtered out; only paths the user can change
              show up. Tap a row to apply the swap. */}
          {swapSuggestions.length > 0 && (
            <div style={{ padding: "0 14px 20px" }}>
              <div style={{ fontSize: T.fs2, color: T.purple, letterSpacing: 1.5, marginBottom: 8, paddingBottom: 4, borderBottom: `1px solid ${T.purple}44`, fontFamily: T.sans, display: "flex", alignItems: "center", gap: 8 }}>
                SUGGESTED SWAPS
                <Tip text="Single-slot upgrades from your current build that don't conflict with anything else installed. Ranked by combined ergo + recoil-ctrl gain. Locked slots and scope/sight/magazine slots are excluded — unlock a slot to surface its swaps." />
              </div>
              {swapSuggestions.map((s) => (
                <button key={s.path} onClick={() => applySwap(s.path, s.toMod.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.purple}`, padding: 8, marginBottom: 4, cursor: "pointer", textAlign: "left" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8 }}>{s.slotName.toUpperCase()}</div>
                    <div style={{ fontSize: T.fs2, color: T.textBright, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: T.textDim }}>{s.fromMod.shortName || s.fromMod.name}</span>
                      <span style={{ color: T.purple, margin: "0 6px" }}>→</span>
                      <span style={{ color: T.textBright, fontWeight: "bold" }}>{s.toMod.shortName || s.toMod.name}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, gap: 1 }}>
                    {s.eDelta !== 0 && <span style={{ fontSize: T.fs1, color: s.eDelta > 0 ? T.success : T.error }}>{s.eDelta > 0 ? "+" : ""}{s.eDelta} ergo</span>}
                    {s.rDelta !== 0 && <span style={{ fontSize: T.fs1, color: s.rDelta > 0 ? T.success : T.error }}>{s.rDelta > 0 ? "+" : ""}{s.rDelta} recoil ctrl</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── RENDER: LEADERBOARD ───
  if (screen === "leaderboard") {
    const modeLabel = { ergo: "ERGO", recoil: "RECOIL", "recoil-balanced": "BAL" };
    const modeColor = { ergo: T.cyan, recoil: T.orange, "recoil-balanced": T.gold };
    // Combined recoil (vertical + horizontal) is what players actually feel
    // in raid — sum both axes so the leaderboard ranks and display use the
    // same metric.
    const totalRecoil = (s) => (s.recoilV || 0) + (s.recoilH || 0);
    const sortedRows = (leaderboardRows || []).slice().sort((a, b) => {
      const diff = leaderboardMode === "ergo"
        ? b.stats.ergo - a.stats.ergo
        : totalRecoil(a.stats) - totalRecoil(b.stats);
      if (diff !== 0) return diff;
      const altDiff = leaderboardMode === "ergo"
        ? totalRecoil(a.stats) - totalRecoil(b.stats)
        : b.stats.ergo - a.stats.ergo;
      if (altDiff !== 0) return altDiff;
      const nameA = (a.weapon.shortName || a.weapon.name || "");
      const nameB = (b.weapon.shortName || b.weapon.name || "");
      return nameA.localeCompare(nameB);
    });
    const loading = leaderboardProgress.loaded < leaderboardProgress.total;
    const loadRowIntoEditor = (row) => {
      setSelectedWeapon(row.weapon);
      setMods({ ...row.mods });
      // Reset editor state so we don't carry over locks / CUSTOM
      // targets / opMode from a prior build. Without this, opening a
      // leaderboard row while previously in CUSTOM mode triggered the
      // CUSTOM auto-run + frontier sweep on the new weapon — for
      // conflict-heavy guns that's many seconds of frozen UI.
      setLockedPaths(new Set());
      setCustomTargets({ e: 0, r: 0 });
      setOpMode("balanced");
      setBuildName(`${row.weapon.shortName || row.weapon.name} (${modeLabel[leaderboardMode]})`);
      setEditingBuild(null);
      setScreen("edit");
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <button onClick={() => setScreen("list")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, padding: 0 }}>← BACK</button>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Tip text="Runs the optimizer across every weapon that fires the selected caliber and shows the best build for each, sorted by the chosen mode. Click a row to open that build in the editor for tweaks." />
              <div style={{ fontSize: T.fs1, color: T.textDim }}>
                {loading
                  ? `${leaderboardProgress.loaded}/${leaderboardProgress.total}`
                  : `${sortedRows.length} build${sortedRows.length === 1 ? "" : "s"}`}
              </div>
            </div>
          </div>
          <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8, marginBottom: 4 }}>CALIBER</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {calibers.map((c) => (
              <Btn key={c} ch={formatCaliber(c)} compact active={leaderboardCaliber === c} onClick={() => setLeaderboardCaliber(c)} />
            ))}
          </div>
          <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.8, marginBottom: 4 }}>OPTIMIZE FOR</div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {["ergo", "recoil", "recoil-balanced"].map((m) => (
              <button
                key={m}
                onClick={() => setLeaderboardMode(m)}
                style={{
                  flex: 1,
                  background: leaderboardMode === m ? modeColor[m] + "22" : "transparent",
                  border: `1px solid ${leaderboardMode === m ? modeColor[m] : T.border}`,
                  color: leaderboardMode === m ? modeColor[m] : T.textDim,
                  padding: "6px 0",
                  fontSize: T.fs1,
                  cursor: "pointer",
                  fontFamily: T.sans,
                  letterSpacing: 0.8,
                  fontWeight: leaderboardMode === m ? "bold" : "normal",
                }}
              >
                {modeLabel[m]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setLeaderboardAvailableOnly((v) => !v)}
            style={{
              width: "100%",
              background: leaderboardAvailableOnly ? T.success + "22" : "transparent",
              border: `1px solid ${leaderboardAvailableOnly ? T.success : T.border}`,
              color: leaderboardAvailableOnly ? T.success : T.textDim,
              padding: "6px 0",
              fontSize: T.fs1,
              cursor: "pointer",
              fontFamily: T.sans,
              letterSpacing: 0.8,
              fontWeight: leaderboardAvailableOnly ? "bold" : "normal",
            }}
          >
            {leaderboardAvailableOnly ? "✓ ONLY BUILDS I CAN MAKE" : "SHOW ONLY BUILDS I CAN MAKE"}
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {weaponsLoading && <div style={{ color: T.textDim, fontSize: T.fs3, textAlign: "center", padding: 20 }}>Loading weapons from tarkov.dev...</div>}
          {!weaponsLoading && loading && (
            <div style={{
              background: T.surface,
              border: `1px solid ${T.border}`,
              borderLeft: `3px solid ${T.gold}`,
              padding: "18px 16px",
              textAlign: "center",
            }}>
              <div style={{ fontSize: T.fs3, color: T.gold, fontWeight: "bold", letterSpacing: 1.5, marginBottom: 6 }}>
                LOADING BUILDS…
              </div>
              <div style={{ fontSize: T.fs2, color: T.textDim }}>
                Fetching weapon data and running the optimizer
              </div>
              <div style={{ fontSize: T.fs2, color: T.textBright, marginTop: 6, fontFamily: T.mono }}>
                {leaderboardProgress.loaded} / {leaderboardProgress.total}
              </div>
            </div>
          )}
          {!weaponsLoading && !loading && sortedRows.length === 0 && (
            <div style={{ color: T.textDim, fontSize: T.fs2, textAlign: "center", padding: 20 }}>No weapons for this caliber.</div>
          )}
          {!loading && sortedRows.map((row, idx) => {
            const w = row.weapon;
            const s = row.stats;
            const isErgoMode = leaderboardMode === "ergo";
            return (
              <button
                key={w.id}
                onClick={() => loadRowIntoEditor(row)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderLeft: `3px solid ${idx === 0 ? T.gold : T.border}`,
                  padding: 10, marginBottom: 6, cursor: "pointer", textAlign: "left",
                }}
              >
                <div style={{ fontSize: T.fs3, color: idx === 0 ? T.gold : T.textDim, fontWeight: "bold", width: 24, textAlign: "center", flexShrink: 0 }}>
                  {idx + 1}
                </div>
                {w.gridImageLink && (
                  <img src={w.gridImageLink} alt="" style={{ width: 64, height: 32, objectFit: "contain", background: T.inputBg, border: `1px solid ${T.border}`, flexShrink: 0 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {w.shortName || w.name}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                    {s.accMod !== 0 && (
                      <span style={{ fontSize: T.fs1, color: s.accMod < 0 ? T.error : T.success }}>
                        {s.accMod > 0 ? "+" : ""}{s.accMod}% acc
                      </span>
                    )}
                    <span style={{ fontSize: T.fs1, color: T.textDim }}>{s.weight}kg</span>
                    <span style={{ fontSize: T.fs1, color: T.textDim }}>{s.modCount} mods</span>
                    <span style={{ fontSize: T.fs1, color: T.gold }}>{fmtPrice(s.totalCost)}</span>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0, minWidth: 72, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{
                    fontSize: T.fs2,
                    fontWeight: isErgoMode ? "normal" : "bold",
                    color: T.orange,
                    lineHeight: 1,
                  }}>
                    R {totalRecoil(s)}
                  </div>
                  <div style={{
                    fontSize: T.fs2,
                    fontWeight: isErgoMode ? "bold" : "normal",
                    color: T.cyan,
                    lineHeight: 1,
                  }}>
                    E {s.ergo}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── RENDER: MY BUILDS LIST (default) ───
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setScreen("pick")} style={{ flex: 1, background: T.gold + "22", border: `2px solid ${T.gold}`, color: T.gold, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, fontWeight: "bold" }}>+ NEW BUILD</button>
          <button onClick={() => setScreen("leaderboard")} style={{ flex: 1, background: T.cyan + "22", border: `2px solid ${T.cyan}`, color: T.cyan, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, fontWeight: "bold" }}>COMPARE BUILDS</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        <SL c={<>MY BUILDS ({savedBuilds.length})<Tip text="Your saved weapon builds. Tap Edit to modify, or Copy Code to share with squadmates." /></>} />
        {savedBuilds.length === 0 && (
          <div style={{ background: T.gold + "11", border: `2px solid ${T.gold}44`, padding: T.sp4, marginBottom: T.sp4, textAlign: "center" }}>
            <div style={{ fontSize: T.fs3, color: T.text, marginBottom: 8 }}>No builds yet</div>
            <div style={{ fontSize: T.fs2, color: T.textDim }}>Tap + NEW BUILD to create your first weapon build, or import one from a share code below.</div>
          </div>
        )}
        {savedBuilds.map(build => (
          <div key={build.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`, padding: 12, marginBottom: 8 }}>
            <div style={{ fontSize: T.fs3, color: T.gold, fontWeight: "bold", marginBottom: 4 }}>{build.name}</div>
            <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 8 }}>{Object.keys(build.mods || {}).length} mods attached</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => loadBuild(build)} style={{ flex: 1, background: T.blueBg, border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "8px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>EDIT</button>
              <button onClick={() => copyBuildCode(build)} style={{ flex: 1, background: copied === build.id ? T.successBg : "transparent", border: `1px solid ${copied === build.id ? T.successBorder : T.border}`, color: copied === build.id ? T.success : T.textDim, padding: "8px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>{copied === build.id ? "✓ COPIED" : "COPY CODE"}</button>
              <button onClick={() => deleteBuild(build.id)} style={{ background: T.errorBg, border: `1px solid ${T.errorBorder}`, color: T.error, padding: "8px 12px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans }}>✕</button>
            </div>
          </div>
        ))}

        {/* Import section */}
        <SL c="IMPORT BUILD" s={{ marginTop: 20 }} />
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
          <div style={{ fontSize: T.fs2, color: T.textDim, lineHeight: 1.6, marginBottom: 8 }}>Paste a build code (TGB:...) to import a squadmate's weapon build.</div>
          <textarea value={importCode} onChange={e => setImportCode(e.target.value)} placeholder="Paste TGB:... code here"
            style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", resize: "none", height: 52, lineHeight: 1.4, marginBottom: 6 }} />
          {importError && <div style={{ fontSize: T.fs2, color: T.error, marginBottom: 6 }}>{importError}</div>}
          <button onClick={importBuild} disabled={!importCode.trim()} style={{ width: "100%", background: importCode.trim() ? T.successBg : "transparent", border: `2px solid ${importCode.trim() ? T.successBorder : T.border}`, color: importCode.trim() ? T.success : T.textDim, padding: "10px 0", fontSize: T.fs2, cursor: importCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1 }}>IMPORT BUILD</button>
        </div>
      </div>
    </div>
  );
}
