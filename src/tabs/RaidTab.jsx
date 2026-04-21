import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { T } from '../theme.js';
import { SL, Badge, Btn, Tip } from '../components/ui/index.js';
import { getObjMeta, worldToPct, nearestNeighbor } from '../lib/utils.js';
import { computeMapRecommendation, computeQuickTasks, computeItemRecommendation, itemNameToCategories } from '../lib/computeUtils.js';
import { EMAPS, MAP_BOUNDS, mergeExtractPositions } from '../lib/mapData.js';
import { LOOT_CONFIG, CAT_TO_LOOT, ET_CONFIG } from '../lib/configData.js';
import { decodeProfile } from '../lib/shareCodes.js';
import { fetchAPI, ITEMS_SEARCH_Q } from '../api.js';
import { traderSort } from '../constants.js';
import { useStorage } from '../hooks/useStorage.js';
import { useSquadRoom } from '../hooks/useSquadRoom.js';
import { useDebouncedCallback } from '../hooks/useDebounce.js';
// MapOverlay is lazy so Leaflet (~70KB + CSS) only loads when a route is rendered
const MapOverlay = lazy(() => import('../components/MapOverlay.jsx'));
import MapRecommendation from '../components/MapRecommendation.jsx';
import ExtractSelector from '../components/ExtractSelector.jsx';
import PostRaidTracker from '../components/PostRaidTracker.jsx';

export default function RaidTab({ myProfile, saveMyProfile, apiMaps, apiTasks, apiTraders, loading, apiError, hideoutTarget, apiHideout, hideoutLevels, pendingRouteTask, clearPendingRouteTask }) {
  const [importCode, setImportCode] = useState("");
  const [importError, setImportError] = useState("");
  const [importedSquad, saveImportedSquad] = useStorage("tg-squad-v3", []);
  const [joinCode, setJoinCode] = useState("");
  const room = useSquadRoom(myProfile);
  const [selectedMapId, setSelectedMapId] = useState(null);
  const [faction, setFaction] = useState("pmc");
  const [activeIds, setActiveIds] = useState(new Set());
  const [priorityTasks, setPriorityTasks] = useState({});
  const [extractChoices, setExtractChoices] = useState({}); // {[playerId]: {extract, confirmed, missingItems}}
  const [route, setRoute] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [resolvedConflicts, setResolvedConflicts] = useState({});
  const [screen, setScreen] = useState("squad");
  const [routeMode, setRouteMode] = useState("tasks"); // "tasks" or "loot"
  const [lootSubMode, setLootSubMode] = useState("all"); // "all", "hideout", "equipment", "stashes"
  const [targetEquipment, saveTargetEquipment] = useStorage("tg-target-equipment-v1", []); // [{id, name, shortName, categories}]
  const [equipSearch, setEquipSearch] = useState("");
  const [equipResults, setEquipResults] = useState(null);
  const [equipSearching, setEquipSearching] = useState(false);
  const [tasksPerPerson, setTasksPerPerson] = useState(1);
  const [plannerView, setPlannerView] = useState("quick"); // "quick" or "full"
  const [squadExpanded, setSquadExpanded] = useState(false);
  const [quickGenPending, setQuickGenPending] = useState(false);
  const [qhStation, setQhStation] = useState(null); // quick hideout: selected station id
  const [qhLevel, setQhLevel] = useState(null); // quick hideout: selected level number
  const [qhItem, setQhItem] = useState(null); // quick hideout: selected item {id, name, shortName, count}
  const [qiSearch, setQiSearch] = useState(""); // quick item search term
  const [qiResults, setQiResults] = useState(null); // quick item search results
  const [targetTrader, setTargetTrader] = useState(null); // targeted trader for map recommendation
  const [quickOverrides, setQuickOverrides] = useState(null); // manual task picks in quick start: {profileId: [taskId,...]} or null=auto
  const [qiSearching, setQiSearching] = useState(false);
  const [qiExpanded, setQiExpanded] = useState(null); // expanded item id to show all map choices
  const [expandedAnyTask, setExpandedAnyTask] = useState(null);
  const [manualPickMapId, setManualPickMapId] = useState(null);
  const [manualPickOverrides, setManualPickOverrides] = useState(null);
  const { schedule: scheduleQiSearch } = useDebouncedCallback(300);
  const { schedule: scheduleEquipSearch, cancel: cancelEquipSearch } = useDebouncedCallback(300);

  // Handle pending route task from profile screen
  useEffect(() => {
    if (!pendingRouteTask || !apiMaps) return;
    const { taskId, mapId } = pendingRouteTask;
    if (mapId) {
      setSelectedMapId(mapId);
      setFaction("pmc");
      setRouteMode("tasks");
      setActiveIds(new Set([myProfile.id]));
      setPriorityTasks({ [myProfile.id]: [taskId] });
      setExtractChoices({});
      setPlannerView("quick");
      setQuickGenPending(true);
    }
    clearPendingRouteTask();
  }, [pendingRouteTask, apiMaps]);

  const searchEquipment = async (term) => {
    if (!term || term.length < 2) { setEquipResults(null); return; }
    setEquipSearching(true);
    try {
      const data = await fetchAPI(ITEMS_SEARCH_Q(term));
      setEquipResults(data?.items || []);
    } catch(e) { setEquipResults([]); }
    setEquipSearching(false);
  };

  // Auto-search equipment with 300ms debounce as user types
  useEffect(() => {
    const term = equipSearch.trim();
    cancelEquipSearch();
    if (term.length < 2) {
      setEquipResults(null);
      setEquipSearching(false);
      return;
    }
    setEquipSearching(true);
    scheduleEquipSearch(() => { searchEquipment(term); });
  }, [equipSearch]);

  // Score loot points by tag relevance, return top 3 — exact tag matches score 3, "Barter item" gets 1
  const rankLootPoints = (lootPoints, neededTags) => {
    if (!lootPoints?.length || !neededTags?.size) return lootPoints;
    // Compute preferred loot point types from needed tags via CAT_TO_LOOT
    const preferredTypes = new Set();
    neededTags.forEach(tag => { (CAT_TO_LOOT[tag] || []).forEach(t => preferredTypes.add(t)); });
    const scored = lootPoints.map(lp => {
      const tags = lp.tags || [];
      let score = 0;
      tags.forEach(t => { if (neededTags.has(t)) score += 3; });
      // Type bonus: prefer loot point types matching the item's categories
      score += preferredTypes.has(lp.type) ? 2 : 0;
      return { lp, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // Take top 3 — but only include nodes with some relevance (score > 0)
    const top = scored.filter(s => s.score > 0).slice(0, 3);
    // If fewer than 3 matched, fill with best remaining general loot points
    if (top.length < 3) {
      const used = new Set(top.map(s => s.lp.name));
      const rest = scored.filter(s => !used.has(s.lp.name)).slice(0, 3 - top.length);
      top.push(...rest);
    }
    return top.map(s => s.lp);
  };

  // Compute filtered loot points based on sub-mode — uses tags for precise matching
  const getFilteredLootPoints = (lootPoints) => {
    if (!lootPoints) return [];
    if (lootSubMode === "all") return lootPoints;
    if (lootSubMode === "hideout" && hideoutTarget && apiHideout) {
      const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
      const level = station?.levels.find(l => l.level === hideoutTarget.level);
      if (level) {
        // Map hideout item names to tags via name heuristics (hideout API doesn't include categories)
        const neededTags = new Set();
        level.itemRequirements.forEach(req => {
          const n = (req.item.name || "").toLowerCase();
          if (n.includes("gpu") || n.includes("graphics") || n.includes("circuit") || n.includes("wire") || n.includes("relay") || n.includes("tetriz") || n.includes("vpx") || n.includes("flash drive") || n.includes("ssd") || n.includes("phase")) neededTags.add("Electronics");
          if (n.includes("ledx") || n.includes("ophthalmoscope") || n.includes("defib") || n.includes("salewa") || n.includes("medic") || n.includes("surv12") || n.includes("cms") || n.includes("vaseline")) neededTags.add("Medical supplies");
          if (n.includes("salewa") || n.includes("grizzly") || n.includes("ifak") || n.includes("afak") || n.includes("cms") || n.includes("surv")) neededTags.add("Meds");
          if (n.includes("stim") || n.includes("propital") || n.includes("etg") || n.includes("sj")) neededTags.add("Stimulant");
          if (n.includes("bolt") || n.includes("screw") || n.includes("nail") || n.includes("duct tape") || n.includes("insulating") || n.includes("bulb") || n.includes("cable") || n.includes("capacitor")) neededTags.add("Building material");
          if (n.includes("wrench") || n.includes("plier") || n.includes("screwdriver") || n.includes("multitool")) neededTags.add("Tool");
          if (n.includes("hose") || n.includes("pipe") || n.includes("motor") || n.includes("filter") || n.includes("tube") || n.includes("corrugated")) neededTags.add("Household goods");
          if (n.includes("fuel") || n.includes("propane") || n.includes("expeditionary")) neededTags.add("Fuel");
          if (n.includes("weapon") || n.includes("gun") || n.includes("rifle") || n.includes("pistol") || n.includes("ak-") || n.includes("m4a1")) neededTags.add("Weapon");
          if (n.includes("intel") || n.includes("folder") || n.includes("diary") || n.includes("sas drive")) neededTags.add("Info");
          if (n.includes("key") && !n.includes("keyboard")) neededTags.add("Key");
          if (n.includes("gold") || n.includes("bitcoin") || n.includes("lion") || n.includes("cat") || n.includes("horse") || n.includes("chain") || n.includes("roler")) neededTags.add("Jewelry");
          // If nothing matched, add broad tags
          if (neededTags.size === 0) { neededTags.add("Barter item"); neededTags.add("Building material"); }
        });
        return rankLootPoints(lootPoints, neededTags);
      }
    }
    if (lootSubMode === "equipment" && targetEquipment.length > 0) {
      // Use actual API categories from the selected items — match against loot point tags
      const neededTags = new Set();
      targetEquipment.forEach(item => {
        (item.categories || []).forEach(c => {
          if (c.name !== "Item" && c.name !== "Compound item" && c.name !== "Stackable item" && c.name !== "Searchable item") {
            neededTags.add(c.name);
          }
        });
      });
      return rankLootPoints(lootPoints, neededTags);
    }
    return lootPoints;
  };

  const selectedMap = useMemo(() => apiMaps?.find(m => m.id === selectedMapId), [apiMaps, selectedMapId]);
  const selectedMapNorm = useMemo(() => apiMaps?.find(m => m.id === selectedMapId)?.normalizedName, [apiMaps, selectedMapId]);
  const emap = useMemo(() => mergeExtractPositions(EMAPS.find(m => m.id === selectedMapNorm), selectedMap), [selectedMapNorm, selectedMap]);
  const allProfiles = useMemo(() => [myProfile, ...room.roomSquad, ...importedSquad.filter(ip => !room.roomSquad.some(rp => rp.name === ip.name))], [myProfile, room.roomSquad, importedSquad]);

  // When map changes, reset extract choices
  useEffect(() => { setExtractChoices({}); }, [selectedMapId, faction]);

  const handleImport = () => {
    setImportError("");
    const decoded = decodeProfile(importCode.trim());
    if (!decoded) { setImportError("Invalid code — check for typos or ask your squadmate to re-copy."); return; }
    if (importedSquad.some(p => p.name === decoded.name)) { setImportError(`Already have "${decoded.name}". Remove first to update.`); return; }
    saveImportedSquad([...importedSquad, decoded]);
    setImportCode("");
  };

  const toggleActive = id => setActiveIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // When leader broadcasts a route and we're not the leader, show it
  useEffect(() => {
    if (room.status !== "connected" || room.isLeader) return;
    if (room.sharedRoute && room.sharedRouteConfig) {
      setRoute(room.sharedRoute);
      if (room.sharedRouteConfig.mapId) setSelectedMapId(room.sharedRouteConfig.mapId);
      if (room.sharedRouteConfig.faction) setFaction(room.sharedRouteConfig.faction);
      if (room.sharedRouteConfig.routeMode) setRouteMode(room.sharedRouteConfig.routeMode);
      setScreen("route");
    }
  }, [room.sharedRoute, room.sharedRouteConfig, room.status, room.isLeader]);

  const generateRoute = useCallback(() => {
    if (!selectedMap || !emap || !activeIds.size) return;

    let positioned = [];
    let unpositioned = [];
    let newConflicts = [];

    if (routeMode === "loot") {
      if (lootSubMode === "stashes") {
        // Stash run: route through hidden stashes from API data
        const bounds = MAP_BOUNDS[selectedMapNorm] || null;
        const stashes = (selectedMap?.lootContainers || []).filter(c =>
          c.lootContainer?.name && (c.lootContainer.name.includes("Buried barrel") || c.lootContainer.name.includes("Ground cache")) && c.position
        ).map((c, i) => {
          const pct = worldToPct(c.position, bounds);
          return pct ? { id: `stash_${i}`, pct, locationName: c.lootContainer.name, isLoot: true,
            players: [{ playerId: "stash", name: "Hidden stash", color: T.success, objective: `◉ ${c.lootContainer.name}`, isCountable: false, total: 1, progress: 0 }],
          } : null;
        }).filter(Boolean);
        positioned = stashes;
      } else {
        // Loot mode: route through filtered loot points
        const filteredLP = getFilteredLootPoints(emap.lootPoints);
        positioned = filteredLP.map((lp, i) => {
          const lc = LOOT_CONFIG[lp.type] || LOOT_CONFIG.mixed;
          return {
            id: `loot_${i}`,
            pct: lp.pct,
            locationName: lp.name,
            isLoot: true,
            players: [{ playerId: "loot", name: lp.note, color: lc.color, objective: `${lc.icon} ${lc.label}`, isCountable: false, total: 1, progress: 0 }],
          };
        });
      }
    } else {
      // Task mode: existing behavior
      const bounds = MAP_BOUNDS[selectedMapNorm] || null;
      const wpMap = new Map();

      activeIds.forEach(pid => {
        const profile = allProfiles.find(p => p.id === pid); if (!profile) return;
        const ptaskIds = priorityTasks[pid] || []; if (!ptaskIds.length) return;

        ptaskIds.forEach(ptaskId => {
          const apiTask = apiTasks?.find(t => t.id === ptaskId); if (!apiTask) return;

          (apiTask.objectives || []).filter(obj => !obj.optional).forEach(obj => {
            const progressKey = `${pid}-${ptaskId}-${obj.id}`;
            const objProgress = (profile.progress || {})[progressKey] || 0;
            const meta = getObjMeta(obj);
            if (objProgress >= meta.total) return;
            const zonePos = obj.zones?.[0]?.position || obj.possibleLocations?.[0]?.positions?.[0] || null;
            const pct = worldToPct(zonePos, bounds);
            const entry = { playerId: pid, name: profile.name, color: profile.color, taskId: ptaskId, objId: obj.id, objective: meta.summary, isCountable: meta.isCountable, total: meta.total, progress: objProgress, wikiLink: apiTask.wikiLink || null };
            if (pct) {
              const gk = `${Math.round(pct.x * 20)}_${Math.round(pct.y * 20)}`;
              if (wpMap.has(gk)) wpMap.get(gk).players.push(entry);
              else wpMap.set(gk, { id: `wp_${gk}`, pct, locationName: obj.description?.split(",")[0] || "Location", players: [entry] });
            } else {
              unpositioned.push({ id: `unpos_${pid}_${obj.id}`, pct: null, locationName: apiTask.name, players: [entry] });
            }
          });
        });
      });

      positioned = [...wpMap.values()];
      positioned.forEach(wp => {
        const pids = [...new Set(wp.players.map(p => p.playerId))];
        if (pids.length > 1) {
          const kills = wp.players.filter(p => p.objective.toLowerCase().startsWith("kill"));
          if (kills.length > 1) newConflicts.push({ id: wp.id, label: `${kills.map(p => p.name).join(" & ")} both have kill objectives here. Merge into one stop?` });
        }
      });
    }

    // Build route: waypoints first (nearest-neighbor), then extract(s) last
    const orderedObjectives = nearestNeighbor(positioned);

    // Build extract waypoints — group players who share the same extract
    const extractWpMap = new Map();
    activeIds.forEach(pid => {
      const ec = extractChoices[pid];
      if (!ec?.extract) return;
      const profile = allProfiles.find(p => p.id === pid);
      if (!profile) return;
      const key = ec.extract.name;
      if (!extractWpMap.has(key)) {
        extractWpMap.set(key, {
          id: `ext_${key.replace(/\s+/g, "_")}`,
          pct: ec.extract.pct,
          extractName: ec.extract.name,
          isExtract: true,
          players: [],
        });
      }
      extractWpMap.get(key).players.push({
        playerId: pid, name: profile.name, color: profile.color,
        missingItems: ec.missingItems || [],
      });
    });
    const extractWaypoints = [...extractWpMap.values()];

    const finalRoute = [...orderedObjectives, ...unpositioned, ...extractWaypoints];
    setRoute(finalRoute);
    setConflicts(newConflicts.filter(c => !resolvedConflicts[c.id]));
    setScreen("route");

    // If leader, broadcast route to room
    if (room.isLeader && room.roomId) {
      room.broadcastRoute(finalRoute, { mapId: selectedMapId, faction, routeMode, lootSubMode });
    }
  }, [selectedMap, emap, activeIds, allProfiles, priorityTasks, apiTasks, extractChoices, resolvedConflicts, routeMode, lootSubMode, targetEquipment, hideoutTarget, apiHideout, room.isLeader, room.roomId]);

  const handleConflictResolve = (id, choice) => {
    setResolvedConflicts(r => ({ ...r, [id]: choice }));
    setConflicts(c => c.filter(x => x.id !== id));
    if (choice === "merge") setRoute(r => r.map(w => { if (w.id !== id) return w; const seen = new Set(); return { ...w, players: w.players.filter(p => { if (seen.has(p.playerId)) return false; seen.add(p.playerId); return true; }) }; }));
  };

  const handleSaveMyProgress = newProgress => saveMyProfile({ ...myProfile, progress: newProgress });

  const canGenerate = useMemo(() => selectedMap && activeIds.size > 0 && (routeMode === "loot" || [...activeIds].some(id => (priorityTasks[id] || []).length > 0)), [selectedMap, activeIds, routeMode, priorityTasks]);

  // Deferred route generation for Quick Start GO button
  useEffect(() => {
    if (quickGenPending && selectedMap && emap && activeIds.size > 0) {
      generateRoute();
      setQuickGenPending(false);
    }
  }, [quickGenPending, selectedMap, emap, activeIds, generateRoute]);

  // Route screen — breaks out of the 480px container to use full width
  if (screen === "route" || screen === "postraid") return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: T.bg, zIndex: 50, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px", flexShrink: 0 }}>
        <button onClick={() => setScreen("squad")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, letterSpacing: 1, cursor: "pointer", fontFamily: T.sans, padding: 0, marginBottom: 6 }}>← BACK TO PLANNER</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: T.fs4, color: T.gold, fontWeight: "bold" }}>{selectedMap?.name} — {routeMode === "loot" ? (lootSubMode === "hideout" ? "Hideout Run" : lootSubMode === "equipment" ? "Equipment Run" : lootSubMode === "stashes" ? "Stash Run" : "Loot Run") : "Squad Route"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Tip text="After your raid, tap POST-RAID to log kills and items found. This updates your progress so your next share code reflects what's done." />
            <button onClick={() => setScreen("postraid")} style={{ background: T.success + "22", border: `1px solid ${T.successBorder}`, color: T.success, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>POST-RAID ▶</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>
          {[...activeIds].map(pid => { const p = allProfiles.find(x => x.id === pid); const tasks = (priorityTasks[pid] || []).map(tid => apiTasks?.find(t => t.id === tid)).filter(Boolean); const ec = extractChoices[pid]; return p ? <div key={pid} style={{ background: p.color + "15", border: `1px solid ${p.color}44`, padding: "2px 7px", fontSize: T.fs2, fontFamily: T.sans, color: p.color }}>{p.name}{tasks.length ? ` — ${tasks.map(t => t.name.slice(0, 14)).join(", ")}` : ""}{ec?.extract ? ` → ⬆ ${ec.extract.name}` : ""}</div> : null; })}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 5%" }}>
        <div aria-live="polite" style={{ maxWidth: 900, margin: "0 auto" }}>
          <Suspense fallback={<div style={{ padding: 30, textAlign: "center", color: T.textDim, fontSize: T.fs2 }}>Loading map…</div>}>
            <MapOverlay apiMap={selectedMap} emap={emap} route={route} conflicts={conflicts} onConflictResolve={handleConflictResolve} />
          </Suspense>

          {/* Keys for this raid */}
          {routeMode === "tasks" && selectedMap?.locks?.length > 0 && route.some(w => w.pct && !w.isExtract) && (() => {
            const bounds = MAP_BOUNDS[selectedMapNorm] || null;
            if (!bounds) return null;
            const routeWps = route.filter(w => w.pct && !w.isExtract);
            // Find locks near route waypoints (within ~5% of map distance)
            const nearbyKeys = [];
            const seenKeys = new Set();
            (selectedMap.locks || []).forEach(lock => {
              if (!lock.key?.name || !lock.position) return;
              const lockPct = worldToPct(lock.position, bounds);
              if (!lockPct) return;
              const nearest = routeWps.reduce((best, wp) => {
                const d = Math.hypot(wp.pct.x - lockPct.x, wp.pct.y - lockPct.y);
                return d < best ? d : best;
              }, Infinity);
              if (nearest < 0.08 && !seenKeys.has(lock.key.name)) {
                seenKeys.add(lock.key.name);
                nearbyKeys.push({ name: lock.key.name, distance: nearest, needsPower: lock.needsPower, type: lock.lockType });
              }
            });
            nearbyKeys.sort((a, b) => a.distance - b.distance);
            if (nearbyKeys.length === 0) return null;
            return (
              <div style={{ background: "#1a1a14", border: `1px solid #3a3a20`, borderLeft: `2px solid #d4b84a`, padding: 10, marginTop: 8 }}>
                <div style={{ fontSize: T.fs3, color: "#d4b84a", letterSpacing: 1, marginBottom: 6 }}>⚿ KEYS NEAR YOUR ROUTE<Tip text="Locked rooms within reach of your route waypoints. Bring these keys if you have them for bonus loot." /></div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {nearbyKeys.slice(0, 12).map(k => (
                    <span key={k.name} style={{ fontSize: T.fs1, color: k.needsPower ? T.orange : T.textBright, background: k.needsPower ? T.orangeBg : "#1e1e14", border: `1px solid ${k.needsPower ? T.orangeBorder : "#3a3a20"}`, padding: "3px 7px" }}>
                      {k.name}{k.needsPower ? " ⚡" : ""}
                    </span>
                  ))}
                  {nearbyKeys.length > 12 && <span style={{ fontSize: T.fs1, color: T.textDim, padding: "3px 7px" }}>+{nearbyKeys.length - 12} more</span>}
                </div>
              </div>
            );
          })()}

          {/* Targeted items reminder */}
          {routeMode === "loot" && lootSubMode === "hideout" && hideoutTarget && apiHideout && (() => {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            const items = level?.itemRequirements?.filter(r => r.item.name !== "Roubles") || [];
            return items.length > 0 ? (
              <div style={{ background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: 12, marginTop: 10 }}>
                <SL c={<>ITEMS TO LOOK FOR<Tip text="These are the items needed for your hideout upgrade. Keep an eye out for them at each stop on the route." /></>} s={{ marginBottom: 8 }} />
                <div style={{ fontSize: T.fs3, color: T.cyan, marginBottom: 8 }}>{station.name} → Level {hideoutTarget.level}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {items.map((r, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: T.cyan + "08", border: `1px solid ${T.cyan}22` }}>
                      <span style={{ fontSize: T.fs4, color: T.textBright }}>{r.item.name}</span>
                      <span style={{ fontSize: T.fs3, color: T.cyan, fontFamily: T.mono }}>×{r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
          {routeMode === "loot" && lootSubMode === "equipment" && targetEquipment.length > 0 && (
            <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: 12, marginTop: 10 }}>
              <SL c={<>ITEMS TO LOOK FOR<Tip text="These are the items you're targeting this raid. Keep an eye out for them at each stop on the route." /></>} s={{ marginBottom: 8 }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {targetEquipment.map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: T.orange + "08", border: `1px solid ${T.orange}22` }}>
                    <span style={{ fontSize: T.fs4, color: T.textBright }}>{item.name}</span>
                    <span style={{ fontSize: T.fs2, color: T.orange, fontFamily: T.sans }}>{(item.categories || []).filter(c => c.name !== "Item" && c.name !== "Compound item").map(c => c.name).slice(0, 2).join(" · ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Transit awareness — suggest next map */}
          {selectedMap?.transits?.length > 0 && routeMode === "tasks" && (() => {
            const playable = ["customs","factory","woods","interchange","shoreline","reserve","lighthouse","streets-of-tarkov","the-lab","ground-zero"];
            const transits = (selectedMap.transits || []).filter(t => t.map?.normalizedName && playable.includes(t.map.normalizedName));
            if (!transits.length) return null;
            // Check which connected maps have incomplete tasks for the player
            const transitSuggestions = transits.map(t => {
              const connMapName = t.map.name || t.map.normalizedName;
              const connMapId = apiMaps?.find(m => m.normalizedName === t.map.normalizedName)?.id;
              const taskCount = connMapId ? (myProfile.tasks || []).filter(({ taskId }) => {
                const apiTask = apiTasks?.find(x => x.id === taskId);
                if (!apiTask || apiTask.map?.id !== connMapId) return false;
                const reqObjs = (apiTask.objectives || []).filter(o => !o.optional);
                const prog = myProfile.progress || {};
                return reqObjs.some(obj => (prog[`${myProfile.id}-${taskId}-${obj.id}`] || 0) < getObjMeta(obj).total);
              }).length : 0;
              return { name: connMapName, norm: t.map.normalizedName, desc: t.description, taskCount };
            }).sort((a, b) => b.taskCount - a.taskCount);
            return (
              <div style={{ background: T.purpleBg, border: `1px solid ${T.purpleBorder}`, borderLeft: `2px solid ${T.purple}`, padding: 10, marginTop: 10 }}>
                <div style={{ fontSize: T.fs3, color: T.purple, letterSpacing: 1, marginBottom: 6 }}>TRANSIT — AFTER THIS RAID<Tip text="Maps connected via the transit system. Extract via a transit point to chain raids without returning to the main menu." /></div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {transitSuggestions.map(t => (
                    <div key={t.norm} style={{ background: t.taskCount > 0 ? T.purple + "15" : "transparent", border: `1px solid ${t.taskCount > 0 ? T.purple : T.border}`, padding: "5px 10px", fontSize: T.fs2, color: t.taskCount > 0 ? T.purple : T.textDim }}>
                      {t.name}{t.taskCount > 0 && <span style={{ color: T.gold, marginLeft: 6, fontSize: T.fs1 }}>★ {t.taskCount} task{t.taskCount > 1 ? "s" : ""}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Extract selection — post-route (when no extract was pre-selected) */}
          {!route.some(w => w.isExtract) && emap && (
            <div style={{ background: T.surface, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: 12, marginTop: 10 }}>
              <SL c={<>CHOOSE YOUR EXTRACT<Tip text="Pick your exit point after seeing the route. It will be added as the final waypoint on your map." /></>} s={{ marginBottom: 8 }} />
              {[...activeIds].map(pid => {
                const p = allProfiles.find(x => x.id === pid);
                if (!p) return null;
                return (
                  <div key={pid} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: T.fs2, color: p.color, letterSpacing: 1, marginBottom: 4, fontFamily: T.sans }}>{p.name.toUpperCase()}'S EXTRACT</div>
                    <ExtractSelector player={p} mapData={emap} faction={faction} choice={extractChoices[pid] || null}
                      onChoice={choice => {
                        const newEC = { ...extractChoices, [pid]: choice };
                        setExtractChoices(newEC);
                        // Dynamically append extract waypoints to route
                        setRoute(prev => {
                          const withoutExtracts = prev.filter(w => !w.isExtract);
                          const extractWpMap = new Map();
                          activeIds.forEach(epid => {
                            const ec = epid === pid ? choice : newEC[epid];
                            if (!ec?.extract) return;
                            const profile = allProfiles.find(x => x.id === epid);
                            if (!profile) return;
                            const key = ec.extract.name;
                            if (!extractWpMap.has(key)) extractWpMap.set(key, { id: `ext_${key.replace(/\s+/g, "_")}`, pct: ec.extract.pct, extractName: ec.extract.name, isExtract: true, players: [] });
                            extractWpMap.get(key).players.push({ playerId: epid, name: profile.name, color: profile.color, missingItems: ec.missingItems || [] });
                          });
                          return [...withoutExtracts, ...extractWpMap.values()];
                        });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {screen === "postraid" && <PostRaidTracker route={route} myProfile={myProfile} onSave={handleSaveMyProgress} onClose={() => setScreen("route")} />}
    </div>
  );

  // ─── Quick Start recommendation ───
  const traderImgMap = useMemo(() => Object.fromEntries((apiTraders || []).map(t => [t.name, t.imageLink])), [apiTraders]);
  const traders = useMemo(() => [...new Set((apiTasks || []).map(t => t.trader?.name).filter(Boolean))].sort(traderSort), [apiTasks]);
  const filteredApiTasks = useMemo(() => targetTrader ? apiTasks?.filter(t => t.trader?.name === targetTrader) : apiTasks, [apiTasks, targetTrader]);
  const quickRec = useMemo(() => computeMapRecommendation(allProfiles, filteredApiTasks), [allProfiles, filteredApiTasks]);
  const quickTopMap = quickRec[0] || null;
  const quickTopApiMap = quickTopMap ? apiMaps?.find(m => m.id === quickTopMap.mapId) : null;
  // All incomplete tasks for the recommended map (unlimited) — used for the picker
  const quickAllTasks = useMemo(() => quickTopMap ? computeQuickTasks(allProfiles, quickTopMap.mapId, filteredApiTasks, 99) : {}, [quickTopMap, allProfiles, filteredApiTasks]);
  // Auto-selected tasks (first N) — used as default before user touches the picker
  const quickAutoTasks = useMemo(() => quickTopMap ? computeQuickTasks(allProfiles, quickTopMap.mapId, filteredApiTasks, tasksPerPerson) : {}, [quickTopMap, allProfiles, filteredApiTasks, tasksPerPerson]);
  // Effective selection: manual overrides if set, otherwise auto
  const quickTasks = quickOverrides || quickAutoTasks;
  const quickTaskCount = Object.values(quickTasks).flat().length;
  // Flat list of all available tasks with details for the picker UI
  const quickAllTaskDetails = useMemo(() => Object.entries(quickAllTasks).flatMap(([pid, tids]) => tids.map(tid => {
    const at = apiTasks?.find(t => t.id === tid);
    if (!at) return null;
    const profile = allProfiles.find(p => p.id === pid);
    const objs = (at.objectives || []).filter(o => !o.optional);
    return { taskId: tid, profileId: pid, name: at.name, trader: at.trader?.name || "", wikiLink: at.wikiLink, objectives: objs, profile };
  })).filter(Boolean), [quickAllTasks, apiTasks, allProfiles]);
  const quickSelectedIds = new Set(Object.values(quickTasks).flat());

  // Manual map pick — computed tasks
  const manualPickMap = manualPickMapId ? apiMaps?.find(m => m.id === manualPickMapId) : null;
  const manualPickAllTasks = manualPickMapId ? computeQuickTasks(allProfiles, manualPickMapId, filteredApiTasks, 99) : {};
  const manualPickAutoTasks = manualPickMapId ? computeQuickTasks(allProfiles, manualPickMapId, filteredApiTasks, tasksPerPerson) : {};
  const manualPickTasks = manualPickOverrides || manualPickAutoTasks;
  const manualPickTaskCount = Object.values(manualPickTasks).flat().length;
  const manualPickAllTaskDetails = Object.entries(manualPickAllTasks).flatMap(([pid, tids]) => tids.map(tid => {
    const at = apiTasks?.find(t => t.id === tid);
    if (!at) return null;
    const profile = allProfiles.find(p => p.id === pid);
    const objs = (at.objectives || []).filter(o => !o.optional);
    return { taskId: tid, profileId: pid, name: at.name, trader: at.trader?.name || "", wikiLink: at.wikiLink, objectives: objs, profile };
  })).filter(Boolean);
  const manualPickSelectedIds = new Set(Object.values(manualPickTasks).flat());

  const handleQuickTaskToggle = (profileId, taskId) => {
    const prev = quickOverrides || quickAutoTasks;
    const profileTasks = prev[profileId] || [];
    const isSelected = profileTasks.includes(taskId);
    let next;
    if (isSelected) {
      next = { ...prev, [profileId]: profileTasks.filter(id => id !== taskId) };
    } else {
      // Check total count across all profiles against tasksPerPerson (per profile)
      if (profileTasks.length >= tasksPerPerson) return; // at limit for this profile
      next = { ...prev, [profileId]: [...profileTasks, taskId] };
    }
    setQuickOverrides(next);
  };

  const handleQuickGo = () => {
    if (!quickTopMap) return;
    setSelectedMapId(quickTopMap.mapId);
    setFaction("pmc");
    setRouteMode("tasks");
    const qIds = new Set([myProfile.id]);
    if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
    setActiveIds(qIds);
    setPriorityTasks(quickTasks);
    // Auto-select first open PMC extract for each player
    const quickMapNorm = apiMaps?.find(m => m.id === quickTopMap.mapId)?.normalizedName;
    const quickEmap = EMAPS.find(m => m.id === quickMapNorm);
    const openExtract = quickEmap?.pmcExtracts?.find(e => e.type === "open" && e.pct);
    if (openExtract) {
      const autoEC = {};
      qIds.forEach(pid => { autoEC[pid] = { extract: openExtract, missingItems: [] }; });
      setExtractChoices(autoEC);
    } else {
      setExtractChoices({});
    }
    setQuickGenPending(true);
  };

  const handleCustomize = () => {
    if (quickTopMap) {
      setSelectedMapId(quickTopMap.mapId);
      setFaction("pmc");
      setRouteMode("tasks");
      const qIds = new Set([myProfile.id]);
      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
      setActiveIds(qIds);
      setPriorityTasks(quickTasks);
    }
    setPlannerView("full");
  };

  const handleManualPickTaskToggle = (profileId, taskId) => {
    const prev = manualPickOverrides || manualPickAutoTasks;
    const profileTasks = prev[profileId] || [];
    const isSelected = profileTasks.includes(taskId);
    let next;
    if (isSelected) {
      next = { ...prev, [profileId]: profileTasks.filter(id => id !== taskId) };
    } else {
      if (profileTasks.length >= tasksPerPerson) return;
      next = { ...prev, [profileId]: [...profileTasks, taskId] };
    }
    setManualPickOverrides(next);
  };

  const handleManualPickGo = () => {
    if (!manualPickMapId) return;
    setSelectedMapId(manualPickMapId);
    setFaction("pmc");
    setRouteMode("tasks");
    const qIds = new Set([myProfile.id]);
    if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
    setActiveIds(qIds);
    setPriorityTasks(manualPickTasks);
    const mapNorm = apiMaps?.find(m => m.id === manualPickMapId)?.normalizedName;
    const mapEmap = EMAPS.find(m => m.id === mapNorm);
    const openExtract = mapEmap?.pmcExtracts?.find(e => e.type === "open" && e.pct);
    if (openExtract) {
      const autoEC = {};
      qIds.forEach(pid => { autoEC[pid] = { extract: openExtract, missingItems: [] }; });
      setExtractChoices(autoEC);
    } else {
      setExtractChoices({});
    }
    setQuickGenPending(true);
    setManualPickMapId(null);
    setManualPickOverrides(null);
  };

  const handleManualPickCustomize = () => {
    if (manualPickMapId) {
      setSelectedMapId(manualPickMapId);
      setFaction("pmc");
      setRouteMode("tasks");
      const qIds = new Set([myProfile.id]);
      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
      setActiveIds(qIds);
      setPriorityTasks(manualPickTasks);
    }
    setManualPickMapId(null);
    setManualPickOverrides(null);
    setPlannerView("full");
  };

  // ─── Quick Start view ───
  if (plannerView === "quick") return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <SL c={<>QUICK START<Tip text="Your recommended raid based on incomplete tasks. Tap GO to jump straight in, or CUSTOMIZE to adjust the map, tasks, and extract." /></>} s={{ marginBottom: 8 }} />
        {loading && <div style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 6 }}>Loading from tarkov.dev...</div>}
        {apiError && <div style={{ fontSize: T.fs3, color: T.error, marginBottom: 6 }}>tarkov.dev unavailable — check connection</div>}
        <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1.5, marginBottom: 4 }}>TARGET TRADER<Tip text="Pick a trader to focus your map recommendation on their tasks. Only maps with incomplete tasks for that trader will be recommended." /></div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
          <button onClick={() => { setTargetTrader(null); setQuickOverrides(null); }} style={{ padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans, background: !targetTrader ? T.gold + "22" : "transparent", border: `1px solid ${!targetTrader ? T.gold : T.border}`, color: !targetTrader ? T.gold : T.textDim, cursor: "pointer" }}>All</button>
          {traders.map(tr => (
            <button key={tr} onClick={() => { setTargetTrader(targetTrader === tr ? null : tr); setQuickOverrides(null); }} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", fontSize: T.fs2, fontFamily: T.sans, background: targetTrader === tr ? T.gold + "22" : "transparent", border: `1px solid ${targetTrader === tr ? T.gold : T.border}`, color: targetTrader === tr ? T.gold : T.textDim, cursor: "pointer" }}>
              {traderImgMap[tr] && <img src={traderImgMap[tr]} alt={tr} style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover" }} />}
              <span>{tr}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {quickTopMap && quickAllTaskDetails.length > 0 ? (
          <div style={{ background: T.surface, border: `2px solid ${T.gold}44`, borderLeft: `2px solid ${T.gold}`, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 8 }}>★ RECOMMENDED MAP{targetTrader ? ` FOR ${targetTrader.toUpperCase()}` : ""}</div>
            <div style={{ fontSize: T.fs6, color: T.gold, fontWeight: "bold", fontFamily: T.sans, letterSpacing: 1, marginBottom: 4 }}>{quickTopMap.mapName}</div>
            <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 10 }}>{quickTopMap.totalTasks} task{quickTopMap.totalTasks !== 1 ? "s" : ""} · {quickTopMap.totalIncomplete} objective{quickTopMap.totalIncomplete !== 1 ? "s" : ""} remaining</div>

            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              {[{n:1,label:"QUICK"},{n:2,label:"STANDARD"},{n:3,label:"LONG"}].map(o => (
                <button key={o.n} onClick={() => { setTasksPerPerson(o.n); setQuickOverrides(null); }} style={{ flex: 1, background: tasksPerPerson === o.n ? T.gold + "22" : "transparent", border: `1px solid ${tasksPerPerson === o.n ? T.gold : T.border}`, color: tasksPerPerson === o.n ? T.gold : T.textDim, padding: "6px 4px", fontSize: T.fs2, fontFamily: T.sans, cursor: "pointer", letterSpacing: 1, textAlign: "center" }}>{o.n} {o.label}</button>
              ))}
            </div>

            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>TASKS — TAP TO SELECT ({quickTaskCount}/{tasksPerPerson})<Tip text="Tap tasks to add or remove them from your raid. The number you can select is based on your raid length above." /></div>
            {quickAllTaskDetails.map((t) => {
              const isSel = quickSelectedIds.has(t.taskId);
              const profileTasks = (quickTasks[t.profileId] || []);
              const atLimit = profileTasks.length >= tasksPerPerson && !isSel;
              return (
                <div key={t.profileId + "-" + t.taskId} onClick={() => handleQuickTaskToggle(t.profileId, t.taskId)}
                  style={{ background: isSel ? T.gold + "11" : "transparent", border: `1px solid ${isSel ? T.gold + "33" : T.border}`, borderLeft: `2px solid ${isSel ? T.gold : T.border}`, padding: "8px 10px", marginBottom: 4, cursor: atLimit ? "default" : "pointer", opacity: atLimit ? 0.4 : 1, transition: "all 0.15s ease" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: T.fs3, color: isSel ? T.textBright : T.textDim }}>{isSel ? "★" : "☆"} {t.name}</span>
                    <span style={{ fontSize: T.fs2, color: T.textDim }}>{t.trader}</span>
                  </div>
                  {t.objectives && t.objectives.length > 0 && (
                    <div style={{ marginTop: 4, paddingLeft: 16 }}>
                      {t.objectives.map(obj => {
                        const meta = getObjMeta(obj);
                        const k = `${t.profileId}-${t.taskId}-${obj.id}`;
                        const progress = ((t.profile?.progress || {})[k] || 0);
                        const done = progress >= meta.total;
                        return (
                          <div key={obj.id} style={{ fontSize: T.fs1, color: done ? T.success : T.textDim, marginTop: 2, display: "flex", alignItems: "flex-start", gap: 4 }}>
                            <span style={{ color: done ? T.success : meta.color, flexShrink: 0 }}>{done ? "✓" : meta.icon}</span>
                            <span style={{ textDecoration: done ? "line-through" : "none", opacity: done ? 0.5 : 1 }}>{obj.description || meta.summary}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={handleQuickGo} disabled={quickTaskCount === 0} style={{ flex: 2, background: quickTaskCount === 0 ? T.textDim : T.gold, color: T.bg, border: "none", padding: "12px 0", fontSize: T.fs4, fontFamily: T.sans, fontWeight: "bold", letterSpacing: 1.5, cursor: quickTaskCount === 0 ? "default" : "pointer", opacity: quickTaskCount === 0 ? 0.4 : 1 }}>▶ GO</button>
              <button onClick={handleCustomize} style={{ flex: 1, background: "transparent", color: T.textDim, border: `1px solid ${T.border}`, padding: "12px 0", fontSize: T.fs3, fontFamily: T.sans, letterSpacing: 1, cursor: "pointer" }}>✎ CUSTOMIZE</button>
            </div>
          </div>
        ) : (
          (() => {
            const anyMapTasks = (myProfile.tasks || []).map(t => {
              const apiTask = apiTasks?.find(x => x.id === t.taskId);
              if (!apiTask || apiTask.map) return null;
              const prog = myProfile.progress || {};
              const reqObjs = (apiTask.objectives || []).filter(o => !o.optional);
              const done = reqObjs.filter(obj => (prog[`${myProfile.id}-${t.taskId}-${obj.id}`] || 0) >= getObjMeta(obj).total).length;
              if (done >= reqObjs.length && reqObjs.length > 0) return null;
              return { taskId: t.taskId, apiTask, completedObjs: done, totalObjs: reqObjs.length, incompleteObjs: reqObjs.filter(obj => (prog[`${myProfile.id}-${t.taskId}-${obj.id}`] || 0) < getObjMeta(obj).total) };
            }).filter(Boolean);
            return anyMapTasks.length > 0 ? (
              <div style={{ background: T.surface, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 4 }}>No map-specific tasks to recommend.</div>
                <SL c={<>ANY MAP TASKS ({anyMapTasks.length})<Tip text="These tasks can be progressed on any map — keep them in mind no matter where you raid!" /></>} s={{ marginBottom: 8, marginTop: 10 }} />
                {anyMapTasks.map(({ taskId, apiTask, completedObjs, totalObjs, incompleteObjs }) => {
                  const traderName = apiTask.trader?.name || "Unknown";
                  return (
                    <div key={taskId} style={{ background: T.cyan + "08", border: `1px solid ${T.cyan}22`, borderLeft: `2px solid ${T.cyan}`, padding: 10, marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                        {traderImgMap[traderName] && <img src={traderImgMap[traderName]} alt={traderName} style={{ width: 24, height: 24, borderRadius: "50%", border: `1px solid ${myProfile.color}44`, objectFit: "cover", flexShrink: 0, marginTop: 2 }} />}
                        <div style={{ flex: 1 }}>
                          <div style={{ color: T.textBright, fontSize: T.fs2, fontWeight: "bold", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{apiTask.name}{apiTask.wikiLink && <a href={apiTask.wikiLink} target="_blank" rel="noreferrer" style={{ background: T.blue + "22", color: T.blue, border: `1px solid ${T.blue}44`, padding: "2px 6px", fontSize: T.fs1, letterSpacing: 0.5, fontFamily: T.sans, whiteSpace: "nowrap", textDecoration: "none", fontWeight: "normal" }}>WIKI ↗</a>}</div>
                          <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                            <Badge label={traderName} color={myProfile.color} />
                            <Badge label="ANY MAP" color={T.cyan} />
                            <span style={{ fontSize: T.fs2, color: T.textDim }}>{completedObjs}/{totalObjs} obj</span>
                          </div>
                          {(() => {
                            const showAll = incompleteObjs.length <= 6;
                            const visible = showAll ? incompleteObjs : incompleteObjs.slice(0, 2);
                            return <>
                              {visible.map(obj => {
                                const meta = getObjMeta(obj);
                                return <div key={obj.id} style={{ fontSize: T.fs1, color: T.textDim, marginTop: 3 }}><span style={{ color: meta.color }}>{meta.icon}</span> {obj.description}</div>;
                              })}
                              {!showAll && <button onClick={() => setExpandedAnyTask(expandedAnyTask === taskId ? null : taskId)} style={{ background: "transparent", border: "none", color: T.blue, fontSize: T.fs1, cursor: "pointer", padding: 0, marginTop: 3, fontFamily: T.sans }}>{expandedAnyTask === taskId ? "▴ show less" : `▾ +${incompleteObjs.length - 2} more`}</button>}
                              {!showAll && expandedAnyTask === taskId && incompleteObjs.slice(2).map(obj => {
                                const meta = getObjMeta(obj);
                                return <div key={obj.id} style={{ fontSize: T.fs1, color: T.textDim, marginTop: 3 }}><span style={{ color: meta.color }}>{meta.icon}</span> {obj.description}</div>;
                              })}
                            </>;
                          })()}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <button onClick={() => setPlannerView("full")} style={{ width: "100%", marginTop: 10, background: "transparent", color: T.textDim, border: `1px solid ${T.border}`, padding: "10px 0", fontSize: T.fs3, fontFamily: T.sans, letterSpacing: 1, cursor: "pointer" }}>✎ OPEN FULL PLANNER</button>
              </div>
            ) : (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 20, textAlign: "center" }}>
                <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 8 }}>No incomplete tasks found.</div>
                <div style={{ fontSize: T.fs3, color: T.textDim }}>Add tasks in the <span style={{ color: T.gold }}>Tasks</span> tab to get a recommendation.</div>
                <button onClick={() => setPlannerView("full")} style={{ marginTop: 14, background: "transparent", color: T.textDim, border: `1px solid ${T.border}`, padding: "10px 20px", fontSize: T.fs3, fontFamily: T.sans, letterSpacing: 1, cursor: "pointer" }}>✎ OPEN FULL PLANNER</button>
              </div>
            );
          })()
        )}

        {/* Pick any map */}
        {apiMaps && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>OR PICK A MAP:</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 5 }}>
              {apiMaps.map(m => {
                const rec = quickRec.find(r => r.mapId === m.id);
                const taskCount = rec ? rec.totalTasks : 0;
                const isTop = quickTopMap && quickTopMap.mapId === m.id;
                return (
                  <button key={m.id} onClick={() => {
                    setManualPickMapId(m.id === manualPickMapId ? null : m.id);
                    setManualPickOverrides(null);
                  }} style={{ background: m.id === manualPickMapId ? T.gold + "33" : isTop ? T.gold + "15" : T.inputBg, border: `1px solid ${m.id === manualPickMapId ? T.gold : isTop ? T.gold + "66" : T.border}`, color: m.id === manualPickMapId ? T.gold : isTop ? T.gold : T.textDim, padding: "8px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textAlign: "center", textTransform: "uppercase", fontWeight: m.id === manualPickMapId ? "bold" : "normal" }}>
                    {m.name}
                    {taskCount > 0 && <div style={{ fontSize: T.fs2, color: T.gold, marginTop: 2 }}>{taskCount} task{taskCount !== 1 ? "s" : ""}</div>}
                  </button>
                );
              })}
            </div>
            {manualPickMapId && manualPickMap && (
              <div style={{ background: T.surface, border: `2px solid ${T.gold}44`, borderLeft: `2px solid ${T.gold}`, padding: 14, marginTop: 10 }}>
                <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 4 }}>★ TASKS ON</div>
                <div style={{ fontSize: T.fs6, color: T.gold, fontWeight: "bold", fontFamily: T.sans, letterSpacing: 1, marginBottom: 8 }}>{manualPickMap.name}</div>
                {manualPickAllTaskDetails.length > 0 ? (
                  <>
                    <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
                      {[{n:1,label:"QUICK"},{n:2,label:"STANDARD"},{n:3,label:"LONG"}].map(o => (
                        <button key={o.n} onClick={() => { setTasksPerPerson(o.n); setManualPickOverrides(null); }} style={{ flex: 1, background: tasksPerPerson === o.n ? T.gold + "22" : "transparent", border: `1px solid ${tasksPerPerson === o.n ? T.gold : T.border}`, color: tasksPerPerson === o.n ? T.gold : T.textDim, padding: "6px 4px", fontSize: T.fs2, fontFamily: T.sans, cursor: "pointer", letterSpacing: 1, textAlign: "center" }}>{o.n} {o.label}</button>
                      ))}
                    </div>
                    <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>SELECT TASKS ({manualPickTaskCount}/{tasksPerPerson})<Tip text="Tap tasks to add or remove them from your raid. Each task shows its objectives so you know what to expect. Hit GO to generate the route." /></div>
                    {manualPickAllTaskDetails.map(t => {
                      const isSel = manualPickSelectedIds.has(t.taskId);
                      const profileTasks = (manualPickTasks[t.profileId] || []);
                      const atLimit = profileTasks.length >= tasksPerPerson && !isSel;
                      return (
                        <div key={t.profileId + "-" + t.taskId} onClick={() => handleManualPickTaskToggle(t.profileId, t.taskId)}
                          style={{ background: isSel ? T.gold + "11" : "transparent", border: `1px solid ${isSel ? T.gold + "33" : T.border}`, borderLeft: `2px solid ${isSel ? T.gold : T.border}`, padding: "8px 10px", marginBottom: 4, cursor: atLimit ? "default" : "pointer", opacity: atLimit ? 0.4 : 1, transition: "all 0.15s ease" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: T.fs3, color: isSel ? T.textBright : T.textDim }}>{isSel ? "★" : "☆"} {t.name}</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {t.wikiLink && <a href={t.wikiLink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ background: T.blue + "22", color: T.blue, border: `1px solid ${T.blue}44`, padding: "1px 5px", fontSize: T.fs1, letterSpacing: 0.5, fontFamily: T.sans, textDecoration: "none" }}>WIKI ↗</a>}
                              <span style={{ fontSize: T.fs2, color: T.textDim }}>{t.trader}</span>
                            </div>
                          </div>
                          {t.objectives && t.objectives.length > 0 && (
                            <div style={{ marginTop: 4, paddingLeft: 16 }}>
                              {t.objectives.map(obj => {
                                const meta = getObjMeta(obj);
                                const k = `${t.profileId}-${t.taskId}-${obj.id}`;
                                const progress = ((t.profile?.progress || {})[k] || 0);
                                const done = progress >= meta.total;
                                return (
                                  <div key={obj.id} style={{ fontSize: T.fs1, color: done ? T.success : T.textDim, marginTop: 2, display: "flex", alignItems: "flex-start", gap: 4 }}>
                                    <span style={{ color: done ? T.success : meta.color, flexShrink: 0 }}>{done ? "✓" : meta.icon}</span>
                                    <span style={{ textDecoration: done ? "line-through" : "none", opacity: done ? 0.5 : 1 }}>{obj.description || meta.summary}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                      <button onClick={handleManualPickGo} disabled={manualPickTaskCount === 0} style={{ flex: 2, background: manualPickTaskCount === 0 ? T.textDim : T.gold, color: T.bg, border: "none", padding: "12px 0", fontSize: T.fs4, fontFamily: T.sans, fontWeight: "bold", letterSpacing: 1.5, cursor: manualPickTaskCount === 0 ? "default" : "pointer", opacity: manualPickTaskCount === 0 ? 0.4 : 1 }}>▶ GO</button>
                      <button onClick={handleManualPickCustomize} style={{ flex: 1, background: "transparent", color: T.textDim, border: `1px solid ${T.border}`, padding: "12px 0", fontSize: T.fs3, fontFamily: T.sans, letterSpacing: 1, cursor: "pointer" }}>✎ CUSTOMIZE</button>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: T.fs2, color: T.textDim, padding: "8px 0" }}>No incomplete tasks on this map. Add tasks in the Tasks tab, or try a loot run below.</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Loot Run section */}
        {apiMaps && (() => {
          // Find best loot map (most loot points)
          let bestLootId = null, bestLootCount = 0;
          apiMaps.forEach(m => {
            const count = EMAPS.find(e => e.id === m.normalizedName)?.lootPoints?.length || 0;
            if (count > bestLootCount) { bestLootCount = count; bestLootId = m.id; }
          });
          // Find hideout-recommended map if target is set
          let hideoutLootId = null;
          if (hideoutTarget && apiHideout) {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            if (level) {
              const neededItems = level.itemRequirements.filter(r => r.item.name !== "Roubles").map(r => ({ id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count }));
              const itemRanked = computeItemRecommendation(neededItems, apiMaps);
              hideoutLootId = itemRanked[0]?.mapId || null;
            }
          }
          return (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: T.fs2, color: T.purple, letterSpacing: 1, marginBottom: 8 }}>◈ LOOT RUN<Tip text="Pick a map to run a loot route — hits all key loot spots. Use CUSTOMIZE in the full planner to filter by hideout or equipment needs." /></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 5 }}>
                {apiMaps.map(m => {
                  const emapData = EMAPS.find(e => e.id === m.normalizedName);
                  const lootCount = emapData?.lootPoints?.length || 0;
                  const isTopLoot = m.id === bestLootId;
                  const isHideoutRec = m.id === hideoutLootId && hideoutLootId !== bestLootId;
                  const accent = isTopLoot ? T.purple : isHideoutRec ? T.cyan : null;
                  return (
                    <button key={m.id} onClick={() => {
                      setSelectedMapId(m.id);
                      setFaction("pmc");
                      setRouteMode("loot");
                      setLootSubMode("all");
                      const qIds = new Set([myProfile.id]);
                      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                      setActiveIds(qIds);
                      setExtractChoices({});
                      setQuickGenPending(true);
                    }} style={{ background: accent ? accent + "15" : T.inputBg, border: `1px solid ${accent ? accent + "66" : T.purple + "33"}`, color: accent || T.textDim, padding: "8px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textAlign: "center", textTransform: "uppercase" }}>
                      {m.name}
                      {isTopLoot && <div style={{ fontSize: 14, color: T.purple, marginTop: 2 }}>★ BEST LOOT</div>}
                      {isHideoutRec && <div style={{ fontSize: 14, color: T.cyan, marginTop: 2 }}>◈ HIDEOUT</div>}
                      {!isTopLoot && !isHideoutRec && lootCount > 0 && <div style={{ fontSize: 14, color: T.purple + "66", marginTop: 2 }}>{lootCount} spot{lootCount !== 1 ? "s" : ""}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Hideout Item Finder */}
        {apiHideout && apiMaps && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.cyan, letterSpacing: 1, marginBottom: 8 }}>◈ FIND HIDEOUT ITEM<Tip text="Pick a hideout station, level, and specific item. We'll find the best map to look for it and generate a loot run." /></div>
            <div style={{ background: T.surface, border: `1px solid ${T.cyan}33`, padding: 10 }}>
              {/* Station picker */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: qhStation ? 8 : 0 }}>
                {apiHideout.filter(s => s.levels.length > 0).sort((a, b) => a.name.localeCompare(b.name)).map(s => {
                  const curLv = (hideoutLevels || {})[s.id] || 0;
                  const maxLv = Math.max(...s.levels.map(l => l.level));
                  const isMaxed = curLv >= maxLv;
                  const isSel = qhStation === s.id;
                  const isTarget = hideoutTarget?.stationId === s.id;
                  return (
                    <button key={s.id} onClick={() => { setQhStation(isSel ? null : s.id); setQhLevel(null); setQhItem(null); }}
                      style={{ display: "flex", alignItems: "center", gap: 4, background: isSel ? T.cyan + "22" : isTarget ? T.orange + "18" : "transparent", border: `1px solid ${isSel ? T.cyan : isTarget ? T.orange : isMaxed ? T.successBorder : T.border}`, color: isSel ? T.cyan : isTarget ? T.orange : isMaxed ? T.success : T.textDim, padding: "4px 8px", fontSize: 14, fontFamily: T.sans, cursor: "pointer", opacity: isMaxed && !isTarget ? 0.6 : 1 }}>
                      {isTarget && !isSel ? "◈ " : ""}{s.name}
                      <span style={{ fontSize: 11, color: isMaxed ? T.success : isTarget && !isSel ? T.orange : isSel ? T.cyan : T.textDim, background: isMaxed ? T.successBorder + "44" : isSel ? T.cyan + "22" : "#ffffff08", padding: "1px 4px", borderRadius: 2 }}>{isMaxed ? "MAX" : `Lv${curLv}`}</span>
                    </button>
                  );
                })}
              </div>
              {/* Level picker */}
              {qhStation && (() => {
                const station = apiHideout.find(s => s.id === qhStation);
                if (!station) return null;
                return (
                  <>
                    {(() => { const curLv = (hideoutLevels || {})[qhStation] || 0; return (
                    <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: qhLevel ? 8 : 0 }}>
                      <span style={{ fontSize: 13, color: T.textDim, marginRight: 2 }}>Your level: <span style={{ color: T.cyan }}>{curLv}</span></span>
                      {station.levels.map(l => {
                        const isBuilt = l.level <= curLv;
                        const isNext = l.level === curLv + 1;
                        const isSel = qhLevel === l.level;
                        const isTargetLv = hideoutTarget?.stationId === qhStation && hideoutTarget?.level === l.level;
                        return (
                          <button key={l.level} onClick={() => { if (isBuilt) return; setQhLevel(isSel ? null : l.level); setQhItem(null); }}
                            style={{ background: isSel ? T.cyan + "22" : isTargetLv ? T.orange + "22" : isBuilt ? T.successBorder + "33" : isNext ? T.cyan + "0a" : "transparent", border: `1px solid ${isSel ? T.cyan : isTargetLv ? T.orange : isBuilt ? T.successBorder : isNext ? T.cyan + "55" : T.border}`, color: isSel ? T.cyan : isTargetLv ? T.orange : isBuilt ? T.success : isNext ? T.cyan : T.textDim, padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans, cursor: isBuilt ? "default" : "pointer", opacity: isBuilt ? 0.5 : 1, fontWeight: isNext || isTargetLv ? "bold" : "normal" }}>{isBuilt ? "✓ " : isTargetLv ? "◈ " : ""}Lv {l.level}</button>
                        );
                      })}
                    </div>
                    ); })()}
                    {/* Item picker */}
                    {qhLevel && (() => {
                      const level = station.levels.find(l => l.level === qhLevel);
                      const items = (level?.itemRequirements || []).filter(r => r.item.name !== "Roubles");
                      if (!items.length) return <div style={{ fontSize: T.fs2, color: T.textDim }}>No items needed for this level.</div>;
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {items.map(r => {
                            const isSel = qhItem?.id === r.item.id;
                            return (
                              <button key={r.item.id} onClick={() => setQhItem(isSel ? null : { id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count })}
                                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: isSel ? T.cyan + "22" : "transparent", border: `1px solid ${isSel ? T.cyan : T.border}`, padding: "6px 10px", cursor: "pointer", textAlign: "left" }}>
                                <span style={{ fontSize: T.fs3, color: isSel ? T.cyan : T.textBright, fontFamily: T.sans }}>{isSel ? "★ " : ""}{r.item.name}</span>
                                <span style={{ fontSize: T.fs2, color: isSel ? T.cyan : T.textDim, fontFamily: T.mono }}>×{r.count}</span>
                              </button>
                            );
                          })}
                          {qhItem && (() => {
                            const ranked = computeItemRecommendation([qhItem], apiMaps);
                            const top3 = ranked.slice(0, 3);
                            if (!top3.length) return null;
                            const topScore = top3[0].score;
                            const itemLabel = qhItem.shortName || qhItem.name.split(" ").slice(0, 2).join(" ");
                            return (
                              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ fontSize: 13, color: T.textDim, letterSpacing: 1, marginBottom: 2 }}>BEST MAPS FOR {itemLabel.toUpperCase()}</div>
                                {top3.map((m, i) => {
                                  const pct = topScore > 0 ? Math.round((m.score / topScore) * 100) : 0;
                                  return (
                                    <button key={m.mapId} onClick={() => {
                                      setSelectedMapId(m.mapId);
                                      setFaction("pmc");
                                      setRouteMode("loot");
                                      setLootSubMode("equipment");
                                      saveTargetEquipment([{ ...qhItem, categories: itemNameToCategories(qhItem.name) }]);
                                      const qIds = new Set([myProfile.id]);
                                      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                                      setActiveIds(qIds);
                                      setExtractChoices({});
                                      setQuickGenPending(true);
                                    }} style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", background: "transparent", border: `1px solid ${i === 0 ? T.cyan : T.border}`, padding: "8px 10px", cursor: "pointer", textAlign: "left", overflow: "hidden" }}>
                                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: i === 0 ? T.cyan + "15" : T.cyan + "08", transition: "width 0.3s" }} />
                                      <span style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, fontSize: T.fs3, color: i === 0 ? T.cyan : T.textBright, fontFamily: T.sans, fontWeight: i === 0 ? "bold" : "normal" }}>
                                        <span style={{ fontSize: 13, color: i === 0 ? T.cyan : T.textDim, minWidth: 16 }}>{i === 0 ? "★" : `#${i + 1}`}</span>
                                        {m.mapName}
                                      </span>
                                      <span style={{ position: "relative", fontSize: 13, color: i === 0 ? T.cyan : T.textDim, fontFamily: T.mono }}>{m.totalContainers} containers · {pct}%</span>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Quick Item Search */}
        {apiMaps && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.orange, letterSpacing: 1, marginBottom: 8 }}>⚡ FIND ANY ITEM<Tip text="Search for any item by name. Click a result to see all maps ranked by loot potential — pick your map, and we'll generate a loot run." /></div>
            <input aria-label="Search items" value={qiSearch} onChange={e => {
              const val = e.target.value;
              setQiSearch(val);
              if (val.length < 2) { setQiResults(null); setQiExpanded(null); return; }
              setQiSearching(true); setQiExpanded(null);
              scheduleQiSearch(() => {
                fetchAPI(`{items(lang:en,name:"${val.replace(/"/g, '\\"')}"){id name shortName categories{name}}}`).then(d => {
                  setQiResults((d?.items || []).slice(0, 8));
                  setQiSearching(false);
                }).catch(() => { setQiResults([]); setQiSearching(false); });
              });
            }} placeholder="Start typing an item name..."
              style={{ ...T.input, width: "100%", fontSize: T.fs2 }} />
            {qiSearching && <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 6 }}>Searching...</div>}
            {qiResults && !qiSearching && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                {qiResults.length === 0 && <div style={{ fontSize: T.fs2, color: T.textDim }}>No items found.</div>}
                {qiResults.map(item => {
                  const ranked = computeItemRecommendation([{ id: item.id, name: item.name, shortName: item.shortName, count: 1 }], apiMaps);
                  const bestMap = ranked[0];
                  const isExpanded = qiExpanded === item.id;
                  return (
                    <div key={item.id} style={{ display: "flex", flexDirection: "column" }}>
                      <button onClick={() => setQiExpanded(isExpanded ? null : item.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: isExpanded ? T.orange + "0a" : T.surface, border: `1px solid ${isExpanded ? T.orange + "44" : T.border}`, padding: "8px 10px", cursor: "pointer", textAlign: "left" }}>
                        <span style={{ fontSize: T.fs3, color: T.textBright, fontFamily: T.sans }}>{item.name}</span>
                        {bestMap && <span style={{ fontSize: 14, color: T.orange, fontFamily: T.sans, whiteSpace: "nowrap", marginLeft: 8 }}>{isExpanded ? "▾" : "▸"} {bestMap.mapName}</span>}
                      </button>
                      {isExpanded && ranked.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0 4px 12px", borderLeft: `2px solid ${T.orange}44` }}>
                          {ranked.map((m, i) => (
                            <button key={m.mapId} onClick={() => {
                              setSelectedMapId(m.mapId);
                              setFaction("pmc");
                              setRouteMode("loot");
                              setLootSubMode("equipment");
                              saveTargetEquipment([{ id: item.id, name: item.name, shortName: item.shortName, categories: item.categories, count: 1 }]);
                              const qIds = new Set([myProfile.id]);
                              if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                              setActiveIds(qIds);
                              setExtractChoices({});
                              setQuickGenPending(true);
                              setQiExpanded(null);
                            }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: i === 0 ? T.gold + "0c" : "transparent", border: `1px solid ${i === 0 ? T.gold + "33" : T.border}`, padding: "6px 10px", cursor: "pointer", textAlign: "left" }}>
                              <span style={{ fontSize: T.fs2, color: i === 0 ? T.gold : T.textBright, fontFamily: T.sans }}>{i === 0 ? "★ " : ""}{m.mapName}</span>
                              <span style={{ fontSize: T.fs1, color: T.textDim, fontFamily: T.sans, whiteSpace: "nowrap", marginLeft: 8 }}>score {m.score}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ─── Full Planner view ───
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <SL c={<>SQUAD RAID PLANNER<Tip text="Plan your squad's raid here. Select a map, import your teammates' codes, choose who's running, pick priority tasks and extracts, then generate an optimized route." /></>} />
          <button onClick={() => setPlannerView("quick")} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans, cursor: "pointer", letterSpacing: 1 }}>← QUICK START</button>
        </div>
        {loading && <div style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 6 }}>Loading maps from tarkov.dev...</div>}
        {apiError && <div style={{ fontSize: T.fs3, color: T.error, marginBottom: 6 }}>tarkov.dev unavailable — check connection</div>}
        {apiMaps && (() => {
          const profiles = activeIds.size > 0 ? allProfiles.filter(p => activeIds.has(p.id)) : allProfiles;
          const taskRanked = computeMapRecommendation(profiles, apiTasks);
          const taskTopId = taskRanked[0] ? taskRanked[0].mapId : null;
          let hideoutTopId = null;
          if (hideoutTarget && apiHideout) {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            if (level) {
              const neededItems = level.itemRequirements.filter(r => r.item.name !== "Roubles").map(r => ({ id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count }));
              const itemRanked = computeItemRecommendation(neededItems, apiMaps);
              hideoutTopId = itemRanked[0] ? itemRanked[0].mapId : null;
            }
          }
          return (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 6, paddingBottom: 6 }}>
              {apiMaps.map(m => {
                const isSel = selectedMapId === m.id;
                const isTaskRec = taskTopId === m.id && !isSel;
                const isHideoutRec = hideoutTopId === m.id && hideoutTopId !== taskTopId && !isSel;
                const bg = isSel ? T.gold + "33" : isTaskRec ? T.gold + "11" : isHideoutRec ? T.cyan + "11" : T.inputBg;
                const border = isSel ? T.gold : isTaskRec ? T.gold + "66" : isHideoutRec ? T.cyan + "66" : T.border;
                const color = isSel ? T.gold : isTaskRec ? T.gold : isHideoutRec ? T.cyan : T.textDim;
                return (
                  <button key={m.id} onClick={() => setSelectedMapId(m.id)} style={{ background: bg, border: `2px solid ${border}`, color, padding: "10px 8px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center", fontWeight: isSel ? "bold" : "normal", transition: "background 0.15s, border-color 0.15s", position: "relative", wordBreak: "break-word", lineHeight: 1.3 }}>
                    {m.name}
                    {isTaskRec && <div style={{ fontSize: T.fs2, color: T.gold, letterSpacing: 1, marginTop: 4 }}>★ TASKS</div>}
                    {isHideoutRec && <div style={{ fontSize: T.fs2, color: T.cyan, letterSpacing: 1, marginTop: 4 }}>◈ HIDEOUT</div>}
                  </button>
                );
              })}
            </div>
          );
        })()}
        {apiTasks && (
          <MapRecommendation
            allProfiles={allProfiles}
            activeIds={activeIds}
            apiTasks={apiTasks}
            apiTraders={apiTraders}
            apiMaps={apiMaps}
            onSelectMap={setSelectedMapId}
            selectedMapId={selectedMapId}
            hideoutTarget={hideoutTarget}
            apiHideout={apiHideout}
          />
        )}
        {selectedMapId && (
          <>
            <div style={{ display: "flex", marginTop: 8, border: `1px solid ${T.border}` }}>
              {["pmc", "scav"].map(f => <button key={f} onClick={() => setFaction(f)} style={{ flex: 1, background: faction === f ? (f === "pmc" ? T.blueBg : T.successBg) : "transparent", color: faction === f ? (f === "pmc" ? T.cyan : T.success) : T.textDim, border: "none", padding: 6, fontSize: T.fs3, letterSpacing: 1.5, cursor: "pointer", textTransform: "uppercase", fontFamily: T.sans, fontWeight: "bold" }}>{f === "pmc" ? "▲ PMC" : "◆ SCAV"}</button>)}
            </div>
            <div style={{ display: "flex", marginTop: 6, border: `1px solid ${T.border}` }}>
              {[{id:"tasks",label:"★ TASKS",color:T.gold},{id:"loot",label:"◈ LOOT RUN",color:T.purple}].map(m => (
                <button key={m.id} onClick={() => setRouteMode(m.id)} style={{ flex: 1, background: routeMode === m.id ? m.color + "22" : "transparent", color: routeMode === m.id ? m.color : T.textDim, border: "none", padding: 6, fontSize: T.fs3, letterSpacing: 1, cursor: "pointer", textTransform: "uppercase", fontFamily: T.sans, fontWeight: "bold" }}>{m.label}</button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* Collapsible Squad Section */}
        <button onClick={() => setSquadExpanded(!squadExpanded)} style={{ width: "100%", background: squadExpanded ? T.successBg : T.surface, border: `1px solid ${room.status === "connected" ? T.successBorder : T.border}`, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: T.sans, marginBottom: squadExpanded ? 0 : 14, borderBottom: squadExpanded ? "none" : undefined }}>
          <span style={{ color: room.status === "connected" ? T.success : T.textDim, letterSpacing: 1, fontSize: T.fs1 }}>◈ SQUAD {room.status === "connected" ? `● ${room.roomCode} (${room.roomSquad.length + 1})` : ""}</span>
          <span style={{ color: T.textDim, fontSize: T.fs2 }}>{squadExpanded ? "▴" : "▾"}</span>
        </button>
        {(squadExpanded || room.status === "connected") && <>
        <SL c={<>SQUAD ROOM<Tip text="Create a room and share the code with your squad. Everyone joins with the code and profiles sync automatically — no more copy-pasting share codes in Discord." /></>} s={{ marginTop: 8 }} />
        <div style={{ background: T.surface, border: `1px solid ${room.status === "connected" ? T.successBorder : T.border}`, padding: 10, marginBottom: 14 }}>
          {room.status === "connected" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: T.fs2, color: T.success, letterSpacing: 1, marginBottom: 2 }}>● CONNECTED</div>
                  <div style={{ fontSize: T.fs4, color: T.textBright, fontWeight: "bold", fontFamily: T.mono, letterSpacing: 1.5 }}>{room.roomCode}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim }}>{room.roomSquad.length + 1} in room</div>
                  <button onClick={room.leaveRoom} style={{ background: "transparent", border: `1px solid ${T.errorBorder}`, color: T.error, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, marginTop: 4 }}>LEAVE</button>
                </div>
              </div>
              {/* Leader controls */}
              {room.reconnecting && (
                <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, padding: "6px 10px", marginBottom: 8, fontSize: T.fs2, color: T.orange, letterSpacing: 1 }}>
                  RECONNECTING...
                </div>
              )}
              <div style={{ background: room.hasLeader ? (room.leaderStale ? T.errorBg : T.successBg) : T.inputBg, border: `1px solid ${room.hasLeader ? (room.leaderStale ? T.errorBorder : T.successBorder) : T.border}`, padding: 8, marginBottom: 8 }}>
                {room.hasLeader ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.orange, marginBottom: 2 }}>★ SQUAD LEADER</div>
                      <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", display: "flex", alignItems: "center", gap: 6 }}>
                        {room.isLeader ? "You are leading" : (() => { const leader = room.roomSquad.find(m => m.deviceId === room.leaderId); return leader ? leader.name : "..."; })()}
                        {!room.isLeader && <span style={{ fontSize: T.fs1, color: room.leaderStale ? T.error : T.success, fontWeight: "normal" }}>{room.leaderStale ? "Away" : "Active"}</span>}
                      </div>
                      {!room.isLeader && room.leaderStale && <div style={{ fontSize: T.fs2, color: T.error, marginTop: 2 }}>Leader disconnected — route may be stale.</div>}
                      {!room.isLeader && !room.leaderStale && <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 2 }}>Leader picks map, tasks & extracts. Route syncs to you.</div>}
                    </div>
                    {room.isLeader && <button onClick={room.releaseLeader} style={{ background: "transparent", border: `1px solid ${T.orangeBorder}`, color: T.orange, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>STEP DOWN</button>}
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: T.fs3, color: T.textDim }}>No squad leader — everyone plans independently.</div>
                    <button onClick={room.claimLeader} style={{ background: T.orange + "22", border: `1px solid ${T.orange}`, color: T.orange, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, whiteSpace: "nowrap" }}>★ LEAD RAID</button>
                  </div>
                )}
              </div>
              <div style={{ fontSize: T.fs3, color: T.textDim }}>Share this code with your squad. Profiles sync live.</div>
              {room.roomSquad.length > 0 && (
                <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                  {room.roomSquad.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                      <span style={{ fontSize: T.fs3, color: p.color, fontWeight: "bold" }}>{p.name}</span>
                      <span style={{ fontSize: T.fs2, color: T.textDim }}>{p.tasks.length} tasks</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>Create a room or join one with a code. Profiles sync automatically.</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button onClick={room.createRoom} disabled={room.status === "creating"} style={{ flex: 1, background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>{room.status === "creating" ? "CREATING..." : "◈ CREATE ROOM"}</button>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input aria-label="Room join code" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="ALPHA-123"
                  style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", letterSpacing: 1, textTransform: "uppercase" }} />
                <button onClick={() => room.joinRoom(joinCode)} disabled={!joinCode.trim() || room.status === "joining"} style={{ background: joinCode.trim() ? T.blueBg : "transparent", border: `1px solid ${joinCode.trim() ? T.blueBorder : T.border}`, color: joinCode.trim() ? T.blue : T.textDim, padding: "8px 14px", fontSize: T.fs3, cursor: joinCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1 }}>{room.status === "joining" ? "..." : "JOIN"}</button>
              </div>
              {room.error && <div style={{ fontSize: T.fs3, color: T.error, marginTop: 6 }}>{room.error}</div>}
            </>
          )}
        </div>

        {/* Import squadmate (fallback) */}
        <SL c={<>IMPORT SQUADMATE CODE<Tip step="FALLBACK" text="If a squadmate can't join the room, they can still share their code the old way — copy from the Profile tab, paste here." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10, marginBottom: 14 }}>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 8 }}>Ask each squadmate to copy their code from the Profile tab and paste it in Discord.</div>
          <textarea aria-label="Import squadmate code" value={importCode} onChange={e => setImportCode(e.target.value)} placeholder="Paste squadmate's TG2:... code here"
            style={{ width: "100%", background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", resize: "none", height: 52, lineHeight: 1.4, marginBottom: 8 }} />
          {importError && <div style={{ fontSize: T.fs3, color: T.error, marginBottom: 6 }}>{importError}</div>}
          <button onClick={handleImport} disabled={!importCode.trim()} style={{ width: "100%", background: importCode.trim() ? T.blueBg : "transparent", border: `1px solid ${importCode.trim() ? T.blueBorder : T.border}`, color: importCode.trim() ? T.blue : T.textDim, padding: "10px 0", fontSize: T.fs2, cursor: importCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase" }}>↓ IMPORT SQUADMATE</button>
        </div>
        </>}

        {/* Players */}
        <SL c={<>SELECT WHO'S RUNNING THIS RAID<Tip step="STEP 2" text="Check the box next to each player joining this raid. In Tasks mode, pick a priority task per player. In Loot Run mode, the route hits all key loot spots on the map." /></>} />
        {allProfiles.map((p, idx) => {
          const isMe = idx === 0;
          const isActive = activeIds.has(p.id);
          const mapTasks = (p.tasks || []).filter(t => apiTasks?.find(at => at.id === t.taskId)?.map?.id === selectedMapId);
          return (
            <div key={p.id} style={{ background: isActive ? p.color + "10" : T.surface, border: `1px solid ${isActive ? p.color : (isMe ? T.borderBright : T.border)}`, borderLeft: `2px solid ${p.color}`, padding: 10, marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isActive && selectedMapId && routeMode === "tasks" ? 8 : 0 }}>
                <button onClick={() => toggleActive(p.id)} style={{ width: 20, height: 20, background: isActive ? p.color : "transparent", border: `1px solid ${p.color}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isActive ? T.bg : T.textDim, fontSize: T.fs3, flexShrink: 0 }}>{isActive ? "✓" : ""}</button>
                <div style={{ flex: 1 }}>
                  <div style={{ color: p.color, fontSize: T.fs3, fontWeight: "bold" }}>{p.name || "(no name)"}{isMe && <span style={{ fontSize: T.fs2, color: T.textDim, fontWeight: "normal", marginLeft: 5 }}>YOU</span>}</div>
                  {!isMe && <div style={{ fontSize: T.fs2, color: p.isRoomMember ? T.success : T.textDim }}>{p.isRoomMember ? "● Live synced" : `Imported ${new Date(p.importedAt).toLocaleDateString()}`} · {p.tasks?.length || 0} tasks</div>}
                </div>
                <Badge label={`${p.tasks?.length || 0} tasks`} color={p.color} />
                {!isMe && !p.isRoomMember && <button onClick={() => { saveImportedSquad(importedSquad.filter(x => x.id !== p.id)); setActiveIds(prev => { const n = new Set(prev); n.delete(p.id); return n; }); }} style={{ background: "transparent", border: "none", color: T.errorBorder, cursor: "pointer", fontSize: T.fs4, padding: "0 2px" }}>×</button>}
              </div>
              {isActive && selectedMapId && routeMode === "tasks" && (
                <>
                  <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 5 }}>PRIORITY TASKS THIS RAID (up to {tasksPerPerson}):</div>
                  {mapTasks.length === 0 ? (
                    <div style={{ fontSize: T.fs3, color: T.textDim }}>No tasks for this map{isMe ? " — add them in the Tasks tab." : "."}</div>
                  ) : mapTasks.map(t => {
                    const at = apiTasks?.find(x => x.id === t.taskId); if (!at) return null;
                    const selected = priorityTasks[p.id] || [];
                    const isPri = selected.includes(t.taskId);
                    const atLimit = selected.length >= tasksPerPerson && !isPri;
                    return <button key={t.taskId} onClick={() => {
                      if (isPri) { setPriorityTasks(pt => ({ ...pt, [p.id]: selected.filter(id => id !== t.taskId) })); }
                      else if (!atLimit) { setPriorityTasks(pt => ({ ...pt, [p.id]: [...selected, t.taskId] })); }
                    }} style={{ width: "100%", background: isPri ? p.color + "22" : "transparent", border: `1px solid ${isPri ? p.color : T.border}`, color: atLimit ? T.border : (isPri ? p.color : T.textDim), padding: "6px 8px", textAlign: "left", cursor: atLimit ? "default" : "pointer", fontFamily: T.sans, fontSize: T.fs3, marginBottom: 4, opacity: atLimit ? 0.5 : 1 }}>{isPri ? "★ " : ""}{at.name}</button>;
                  })}
                </>
              )}
            </div>
          );
        })}

        {importedSquad.length === 0 && <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: "14px 10px", textAlign: "center", marginBottom: 12 }}><div style={{ fontSize: T.fs2, color: T.textDim }}>No squadmates imported yet.<br />Paste their codes above.</div></div>}

        {/* ── LOOT POINTS PREVIEW (loot mode) ── */}
        {routeMode === "loot" && selectedMapId && emap && (() => {
          const filteredLP = getFilteredLootPoints(emap.lootPoints);
          const hasHideout = hideoutTarget && apiHideout;
          const hasEquip = targetEquipment.length > 0;
          return (
          <div style={{ marginTop: 8, marginBottom: 14 }}>
            {/* Sub-mode selector */}
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {[
                {id:"all",label:"ALL LOOT",color:T.purple},
                {id:"stashes",label:"STASHES",color:T.success},
                {id:"hideout",label:"HIDEOUT",color:T.cyan,disabled:!hasHideout},
                {id:"equipment",label:"EQUIPMENT",color:T.orange},
              ].map(m => (
                <button key={m.id} onClick={() => !m.disabled && setLootSubMode(m.id)} style={{
                  flex: 1, padding: "6px 4px", fontSize: T.fs2, letterSpacing: 1, fontFamily: T.sans,
                  background: lootSubMode === m.id ? m.color + "22" : "transparent",
                  border: `1px solid ${lootSubMode === m.id ? m.color : T.border}`,
                  color: m.disabled ? T.border : (lootSubMode === m.id ? m.color : T.textDim),
                  cursor: m.disabled ? "default" : "pointer", opacity: m.disabled ? 0.5 : 1,
                }}>{m.label}</button>
              ))}
            </div>

            {/* Hideout mode info */}
            {lootSubMode === "stashes" && (() => {
              const stashCount = (selectedMap?.lootContainers || []).filter(c =>
                c.lootContainer?.name && (c.lootContainer.name.includes("Buried barrel") || c.lootContainer.name.includes("Ground cache")) && c.position
              ).length;
              const hasBounds = selectedMapNorm && MAP_BOUNDS[selectedMapNorm];
              return (
                <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs2, color: T.success }}>◉ {stashCount} hidden stashes on {selectedMap?.name || "this map"}</div>
                  <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>Route will hit every stash with nearest-neighbor optimization.{!hasBounds ? " Map coordinates unavailable — stashes may not render on map." : ""}</div>
                </div>
              );
            })()}
            {lootSubMode === "hideout" && !hasHideout && (
              <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 10, marginBottom: 8, textAlign: "center" }}>
                <div style={{ fontSize: T.fs3, color: T.textDim }}>Set a hideout target in Tasks → Hideout first.</div>
              </div>
            )}
            {lootSubMode === "hideout" && hasHideout && (() => {
              const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
              const level = station?.levels.find(l => l.level === hideoutTarget.level);
              return station && level ? (
                <div style={{ background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.cyan, marginBottom: 3 }}>TARGETING ITEMS FOR:</div>
                  <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", marginBottom: 4 }}>{station.name} → Level {hideoutTarget.level}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {level.itemRequirements.filter(r => r.item.name !== "Roubles").map((r, i) => (
                      <div key={i} style={{ fontSize: T.fs2, color: T.cyan, background: T.cyan + "15", border: `1px solid ${T.cyan}33`, padding: "2px 6px" }}>
                        {r.item.shortName || r.item.name} ×{r.count}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}

            {/* Equipment mode — search + selected items */}
            {lootSubMode === "equipment" && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.orange, marginBottom: 4 }}>TARGET EQUIPMENT<Tip text="Search for any item — weapons, armor, barter goods, keys, etc. The route will only visit locations likely to contain your targeted items." /></div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input aria-label="Search equipment" value={equipSearch} onChange={e => setEquipSearch(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && searchEquipment(equipSearch)}
                      placeholder="Search items (e.g. AK-74, Slick, GPU)..."
                      style={{ flex: 1, background: T.inputBg, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "6px 8px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box" }} />
                    <button onClick={() => searchEquipment(equipSearch)}
                      style={{ background: T.orange + "22", border: `1px solid ${T.orange}`, color: T.orange, padding: "6px 10px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, flexShrink: 0 }}>SEARCH</button>
                  </div>
                </div>

                {/* Search results */}
                {equipSearching && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>Searching tarkov.dev...</div>}
                {equipResults && !equipSearching && (
                  <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
                    {equipResults.length === 0 && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>No items found.</div>}
                    {equipResults.map(item => {
                      const added = targetEquipment.some(e => e.id === item.id);
                      return (
                        <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", marginBottom: 2, background: added ? T.orange + "15" : T.surface, border: `1px solid ${added ? T.orange + "44" : T.border}` }}>
                          <div>
                            <div style={{ fontSize: T.fs2, color: T.textBright }}>{item.name}</div>
                            <div style={{ fontSize: T.fs1, color: T.textDim }}>{item.categories?.map(c => c.name).filter(n => n !== "Item" && n !== "Compound item").slice(0, 3).join(" · ")}</div>
                          </div>
                          <button onClick={() => {
                            if (added) saveTargetEquipment(targetEquipment.filter(e => e.id !== item.id));
                            else saveTargetEquipment([...targetEquipment, { id: item.id, name: item.name, shortName: item.shortName, categories: item.categories }]);
                          }} style={{ background: added ? T.errorBg : "transparent", border: `1px solid ${added ? T.errorBorder : T.orange}`, color: added ? T.error : T.orange, padding: "4px 8px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, flexShrink: 0 }}>
                            {added ? "✕" : "+ ADD"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Selected equipment */}
                {targetEquipment.length > 0 && (
                  <div>
                    <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.orange, marginBottom: 4 }}>TARGETING {targetEquipment.length} ITEM{targetEquipment.length !== 1 ? "S" : ""}:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                      {targetEquipment.map(item => (
                        <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 4, background: T.orange + "15", border: `1px solid ${T.orange}33`, padding: "3px 6px" }}>
                          <span style={{ fontSize: T.fs3, color: T.orange }}>{item.shortName || item.name}</span>
                          <button onClick={() => saveTargetEquipment(targetEquipment.filter(e => e.id !== item.id))}
                            style={{ background: "transparent", border: "none", color: T.errorBorder, cursor: "pointer", fontSize: T.fs4, padding: 0 }}>×</button>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => saveTargetEquipment([])}
                      style={{ background: "transparent", border: `1px solid ${T.errorBorder}`, color: T.error, padding: "3px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>CLEAR ALL</button>
                  </div>
                )}
                {targetEquipment.length === 0 && !equipResults && (
                  <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>Search and add items you want to find in raid.</div>
                )}
              </div>
            )}

            <div style={{ background: T.purpleBg, border: `1px solid ${T.purpleBorder}`, borderLeft: `2px solid ${T.purple}`, padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: T.fs3, color: T.purple, letterSpacing: 1.5, marginBottom: 4 }}>◈ {lootSubMode === "hideout" ? "HIDEOUT" : lootSubMode === "equipment" ? "EQUIPMENT" : "LOOT"} RUN — {emap.name.toUpperCase()}<Tip text="ALL hits every loot spot. HIDEOUT filters to spots matching your hideout upgrade needs. EQUIPMENT filters to spots matching your targeted items." /></div>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7 }}>
                Route will hit {filteredLP.length} of {emap.lootPoints?.length || 0} loot locations{lootSubMode !== "all" ? " (filtered)" : ""}, ending at your chosen extract.
              </div>
            </div>
            {filteredLP.map((lp, i) => {
              const lc = LOOT_CONFIG[lp.type] || LOOT_CONFIG.mixed;
              return (
                <div key={i} style={{ background: lc.bg, border: `1px solid ${lc.border}`, borderLeft: `2px solid ${lc.color}`, padding: "7px 10px", marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>{lc.icon} {lp.name}</div>
                    <div style={{ fontSize: T.fs1, color: lc.color, letterSpacing: 1, background: lc.border + "44", padding: "2px 6px" }}>{lc.label.toUpperCase()}</div>
                  </div>
                  <div style={{ fontSize: T.fs3, color: lc.color, marginTop: 3 }}>{lp.note}</div>
                </div>
              );
            })}
            {filteredLP.length === 0 && (
              <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: T.fs2, color: T.textDim }}>No matching loot locations on this map for your {lootSubMode === "hideout" ? "hideout target" : "targeted items"}.</div>
              </div>
            )}
          </div>
          );
        })()}

        {/* ── EXTRACT SELECTION ── */}
        {selectedMapId && emap && activeIds.size > 0 && (
          <div style={{ marginTop: 8, marginBottom: 14 }}>
            <div style={{ background: T.blueBg, border: `1px solid ${T.blueBorder}`, borderLeft: `2px solid ${T.blue}`, padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ fontSize: T.fs3, color: T.blue, letterSpacing: 1.5, marginBottom: 4 }}>⬆ EXTRACT SELECTION<Tip step={routeMode === "tasks" ? "STEP 3" : "STEP 3"} text="Pick each player's intended extract. Special extracts (key, paracord, etc.) will ask if you have the required items. Your chosen extract becomes the final stop on the route." /></div>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7 }}>
                Extracts are only revealed when the raid loads — but you can plan ahead. Select your intended exit now. Special extracts will ask if you have required items before adding them to the route.
              </div>
            </div>
            {[...activeIds].map(pid => {
              const p = allProfiles.find(x => x.id === pid); if (!p) return null;
              return (
                <div key={pid} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: T.fs2, color: p.color, letterSpacing: 1, marginBottom: 5, fontFamily: T.sans }}>
                    {p.name.toUpperCase()}'S EXTRACT
                  </div>
                  <ExtractSelector
                    player={p}
                    mapData={emap}
                    faction={faction}
                    choice={extractChoices[pid] || null}
                    onChoice={choice => setExtractChoices(ec => ({ ...ec, [pid]: choice }))}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Tasks per person */}
        {routeMode === "tasks" && selectedMapId && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: T.fs3, color: T.textDim, letterSpacing: 1, fontFamily: T.sans, whiteSpace: "nowrap" }}>TASKS PER PERSON:</div>
            <div style={{ display: "flex", gap: 4 }}>
              {[1, 2, 3].map(n => (
                <button key={n} onClick={() => setTasksPerPerson(n)} style={{ width: 44, height: 44, background: tasksPerPerson === n ? T.gold + "22" : "transparent", border: `1px solid ${tasksPerPerson === n ? T.gold : T.border}`, color: tasksPerPerson === n ? T.gold : T.textDim, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, fontWeight: tasksPerPerson === n ? "bold" : "normal" }}>{n}</button>
              ))}
            </div>
            <div style={{ fontSize: T.fs2, color: T.textDim }}>{tasksPerPerson === 1 ? "Quick raid" : tasksPerPerson === 2 ? "Standard raid" : "Long raid"}</div>
          </div>
        )}

        {/* Pre-raid checklist */}
        {routeMode === "tasks" && selectedMapId && (() => {
          const bringItems = [];
          const selectedMap = apiMaps?.find(m => m.id === selectedMapId);
          const mapLocks = selectedMap?.locks || [];
          // Collect items from selected task objectives
          [...activeIds].forEach(pid => {
            (priorityTasks[pid] || []).forEach(taskId => {
              const apiTask = apiTasks?.find(t => t.id === taskId);
              if (!apiTask) return;
              (apiTask.objectives || []).forEach(obj => {
                if (obj.optional) return;
                if ((obj.type === "mark") && obj.markerItem?.name) {
                  if (!bringItems.some(b => b.name === obj.markerItem.name)) bringItems.push({ name: obj.markerItem.name, type: "marker", icon: "⚑", color: "#9a7aba" });
                }
                if ((obj.type === "plantItem" || obj.type === "plantQuestItem") && obj.description) {
                  const match = obj.description.match(/(?:plant|place|hide|stash|install|set up|deploy)\s+(?:the\s+)?(.+?)(?:\s+(?:in|on|at|near|next|inside|behind|under))/i);
                  if (match) {
                    const itemName = match[1].replace(/^(?:a|an|the)\s+/i, "");
                    if (!bringItems.some(b => b.name === itemName)) bringItems.push({ name: itemName, type: "plant", icon: "⬇", color: "#d4943a" });
                  }
                }
                if (obj.type === "useItem" && obj.useAny?.[0]?.name) {
                  if (!bringItems.some(b => b.name === obj.useAny[0].name)) bringItems.push({ name: obj.useAny[0].name, type: "use", icon: "✦", color: "#d4943a" });
                }
              });
            });
          });
          // Keys for this map
          const uniqueKeys = [...new Set(mapLocks.map(l => l.key?.name).filter(Boolean))].sort();
          if (bringItems.length === 0 && uniqueKeys.length === 0) return null;
          return (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.cyan}`, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: T.fs3, color: T.cyan, letterSpacing: 1, marginBottom: 6 }}>🎒 PRE-RAID CHECKLIST<Tip text="Items you'll need for your selected tasks. Check you have these before entering the raid." /></div>
              {bringItems.map((item, i) => (
                <div key={i} style={{ fontSize: T.fs2, color: item.color, marginBottom: 3 }}>
                  <span>{item.icon}</span> {item.name} <span style={{ color: T.textDim, fontSize: T.fs1 }}>({item.type})</span>
                </div>
              ))}
              {uniqueKeys.length > 0 && (
                <details style={{ marginTop: bringItems.length > 0 ? 6 : 0 }}>
                  <summary style={{ fontSize: T.fs2, color: "#d4b84a", cursor: "pointer", fontFamily: T.sans }}>⚿ {uniqueKeys.length} locked rooms on this map</summary>
                  <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {uniqueKeys.slice(0, 20).map(k => <span key={k} style={{ fontSize: T.fs1, color: T.textDim, background: "#1a1a14", border: `1px solid #3a3a20`, padding: "2px 6px" }}>{k}</span>)}
                    {uniqueKeys.length > 20 && <span style={{ fontSize: T.fs1, color: T.textDim }}>+{uniqueKeys.length - 20} more</span>}
                  </div>
                </details>
              )}
            </div>
          );
        })()}

        {/* Generate */}
        <button onClick={generateRoute} disabled={!canGenerate}
          style={{ width: "100%", background: canGenerate ? (routeMode === "loot" ? T.purple : T.gold) : "transparent", color: canGenerate ? T.bg : T.textDim, border: `2px solid ${canGenerate ? (routeMode === "loot" ? T.purple : T.gold) : T.border}`, padding: `${T.sp3}px 0`, fontSize: T.fs4, letterSpacing: 1.5, cursor: canGenerate ? "pointer" : "default", fontFamily: T.sans, textTransform: "uppercase", fontWeight: "bold", marginBottom: T.sp2, transition: "background 0.15s, border-color 0.15s" }}>
          ▶ {routeMode === "loot" ? (lootSubMode === "hideout" ? "GENERATE HIDEOUT RUN" : lootSubMode === "equipment" ? "GENERATE EQUIPMENT RUN" : lootSubMode === "stashes" ? "GENERATE STASH RUN" : "GENERATE LOOT RUN") : "GENERATE ROUTE"}{activeIds.size > 0 ? ` — ${activeIds.size} PLAYER${activeIds.size > 1 ? "S" : ""}` : ""}
        </button>
        {!selectedMapId && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", fontFamily: T.sans, marginBottom: 4 }}>Select a map above to get started</div>}
        {routeMode === "tasks" && selectedMapId && activeIds.size > 0 && ![...activeIds].some(id => (priorityTasks[id] || []).length > 0) && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", fontFamily: T.sans, marginBottom: 4 }}>Select a priority task for at least one active player</div>}

        <div style={{ marginTop: 12, background: T.surface, border: `1px solid ${T.blueBorder}`, borderLeft: `2px solid ${T.blueBorder}`, padding: 10 }}>
          <div style={{ fontSize: T.fs3, color: T.blue, lineHeight: 1.8 }}>{routeMode === "loot" ? "◈ Loot positions are approximate — use tarkov.dev for exact locations." : "ℹ Task data live from tarkov.dev — always current patch."}<br />Extract positions are approximate — exact locations shown on tarkov.dev.{routeMode === "tasks" && <><br />Reshare your code after completing tasks.</>}</div>
        </div>
        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}

