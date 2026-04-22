import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { T } from "../theme.js";
import { fetchAPI, TASKS_Q, MAPS_Q } from "../api.js";
import { MAP_BOUNDS, MAP_SVG_NAMES, EMAPS } from "../lib/mapData.js";
import {
  buildObjectiveMarkers,
  tasksWithObjectivesOnMap,
  taskColor,
} from "../lib/taskMapUtils.js";

const MAP_STORAGE_KEY = "tg-taskmap-mapid-v1";
const TASKS_STORAGE_KEY = "tg-taskmap-tasks-v1"; // { [mapId]: [taskId, ...] }
const EXTRACTS_STORAGE_KEY = "tg-taskmap-extracts-v1"; // { pmc: bool, scav: bool }
const PROFILE_STORAGE_KEY = "tg-myprofile-v3";

// Faction colors for extract markers + labels. Matches the PMC/SCAV
// color scheme used on the Intel tab's extracts view.
const EXTRACT_COLOR_PMC = "#5cc8e6";
const EXTRACT_COLOR_SCAV = "#7ab87a";

// Tarkov's internal map names (from RaidStarted events in logs) → our
// normalizedName. Mirrors the mapping in LogWatcherSection.prettyMap but in
// the opposite direction, so we can auto-select the map the user is
// currently in.
const TARKOV_TO_NORMALIZED = {
  bigmap: "customs",
  Woods: "woods",
  Interchange: "interchange",
  Shoreline: "shoreline",
  RezervBase: "reserve",
  Lighthouse: "lighthouse",
  Laboratory: "the-lab",
  TarkovStreets: "streets-of-tarkov",
  Sandbox: "ground-zero",
  Sandbox_high: "ground-zero",
  factory4_day: "factory",
  factory4_night: "factory",
};

// Module-level API cache so closing and reopening the popout (Alt+M twice)
// doesn't hit the network again.
let __apiCache = null;
async function loadApi() {
  if (__apiCache) return __apiCache;
  const [tasksData, mapsData] = await Promise.all([fetchAPI(TASKS_Q), fetchAPI(MAPS_Q)]);
  __apiCache = {
    apiTasks: tasksData?.tasks || [],
    apiMaps: mapsData?.maps || [],
  };
  return __apiCache;
}

// Keep the popout in sync with the profile saved by the main window. Uses
// the same storage-event pattern as the scanner popout.
function useProfileLive() {
  const read = () => {
    try {
      const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  };
  const [myProfile, setMyProfile] = useState(read);
  useEffect(() => {
    const refresh = () => setMyProfile(read());
    const handler = (e) => { if (!e.key || e.key === PROFILE_STORAGE_KEY) refresh(); };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  return myProfile;
}

// Inject the dark-theme Leaflet popup + zoom-control CSS once. Duplicates
// the rules from ErrorBoundary.jsx so the popout looks correct even if the
// main-window module isn't loaded in the popout's bundle graph.
function useLeafletDarkTheme() {
  useEffect(() => {
    const id = "tg-taskmap-leaflet-css";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      .leaflet-container { background: ${T.bg} !important; }
      .leaflet-control-zoom a { background: ${T.surface} !important; color: ${T.gold} !important; border-color: ${T.border} !important; }
      .leaflet-control-zoom a:hover { background: ${T.surfaceHover} !important; }
      .tg-taskmap-popup .leaflet-popup-content-wrapper { background: rgba(13,17,23,0.96); color: ${T.textBright}; border: 1px solid ${T.borderBright}; border-radius: ${T.r1}px; box-shadow: 0 2px 8px rgba(0,0,0,0.6); }
      .tg-taskmap-popup .leaflet-popup-content { margin: 6px 8px; font-family: ${T.sans}; font-size: 11px; }
      .tg-taskmap-popup .leaflet-popup-tip { background: rgba(13,17,23,0.96); border: 1px solid ${T.borderBright}; }
    `;
    document.head.appendChild(style);
  }, []);
}

export default function TaskMapPopout() {
  useLeafletDarkTheme();
  const myProfile = useProfileLive();

  const [apiTasks, setApiTasks] = useState([]);
  const [apiMaps, setApiMaps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(null);

  const [selectedMapId, setSelectedMapId] = useState(
    () => localStorage.getItem(MAP_STORAGE_KEY) || null
  );
  const [selectionsByMap, setSelectionsByMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY)) || {}; }
    catch (_) { return {}; }
  });
  const [extractFactions, setExtractFactions] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(EXTRACTS_STORAGE_KEY));
      return raw && typeof raw === "object"
        ? { pmc: !!raw.pmc, scav: !!raw.scav }
        : { pmc: false, scav: false };
    } catch (_) {
      return { pmc: false, scav: false };
    }
  });
  const [tasksOpen, setTasksOpen] = useState(false);
  const tasksBtnRef = useRef(null);

  const mapContainerRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markersLayerRef = useRef(null);
  const imageOverlayRef = useRef(null);

  // ── Load API data once ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    loadApi()
      .then((data) => {
        if (cancelled) return;
        setApiTasks(data.apiTasks);
        setApiMaps(data.apiMaps);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setApiError(String(err?.message || err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Maps we can actually render (have bounds + a known SVG file).
  const renderableMaps = useMemo(
    () => apiMaps.filter((m) => MAP_BOUNDS[m.normalizedName] && MAP_SVG_NAMES[m.normalizedName]),
    [apiMaps]
  );
  const sortedMaps = useMemo(
    () => [...renderableMaps].sort((a, b) => a.name.localeCompare(b.name)),
    [renderableMaps]
  );

  // Default map selection: prefer an in-progress raid, else alphabetical first.
  useEffect(() => {
    if (selectedMapId || !renderableMaps.length) return;
    const raids = myProfile?.raidHistory || [];
    const inProgress = raids.find((r) => !r.end);
    if (inProgress?.map) {
      const normName = TARKOV_TO_NORMALIZED[inProgress.map];
      const match = renderableMaps.find((m) => m.normalizedName === normName);
      if (match) { setSelectedMapId(match.id); return; }
    }
    setSelectedMapId(sortedMaps[0]?.id || null);
  }, [renderableMaps, sortedMaps, selectedMapId, myProfile]);

  // If the saved mapId no longer matches a renderable map (e.g. API drift),
  // fall back to the first one so the popout never shows a blank map.
  useEffect(() => {
    if (!selectedMapId || !renderableMaps.length) return;
    if (!renderableMaps.find((m) => m.id === selectedMapId)) {
      setSelectedMapId(sortedMaps[0]?.id || null);
    }
  }, [selectedMapId, renderableMaps, sortedMaps]);

  // Persist map selection
  useEffect(() => {
    if (selectedMapId) localStorage.setItem(MAP_STORAGE_KEY, selectedMapId);
  }, [selectedMapId]);

  // Persist per-map task selection
  useEffect(() => {
    localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(selectionsByMap));
  }, [selectionsByMap]);

  // Persist extract faction toggles (global, not per-map)
  useEffect(() => {
    localStorage.setItem(EXTRACTS_STORAGE_KEY, JSON.stringify(extractFactions));
  }, [extractFactions]);

  // Close the tasks dropdown on outside-click
  useEffect(() => {
    if (!tasksOpen) return;
    const onClick = (e) => {
      if (tasksBtnRef.current && !tasksBtnRef.current.contains(e.target)) setTasksOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [tasksOpen]);

  // ── Derived data ─────────────────────────────────────────────────────
  const selectedMap = useMemo(
    () => renderableMaps.find((m) => m.id === selectedMapId) || null,
    [renderableMaps, selectedMapId]
  );

  const activeTaskIds = useMemo(
    () => (myProfile?.tasks || []).map((t) => t?.taskId).filter(Boolean),
    [myProfile]
  );

  const tasksOnMap = useMemo(
    () => tasksWithObjectivesOnMap(apiTasks, activeTaskIds, selectedMap),
    [apiTasks, activeTaskIds, selectedMap]
  );

  // Per-map selection — default to ALL tasks-on-map selected if the user
  // hasn't made a choice for this map yet. Once they touch the selection,
  // we store an explicit array (even if empty) so "select none" sticks.
  const selectedTaskIds = useMemo(() => {
    if (!selectedMapId) return [];
    const raw = selectionsByMap[selectedMapId];
    if (Array.isArray(raw)) {
      const valid = new Set(tasksOnMap.map((t) => t.id));
      return raw.filter((id) => valid.has(id));
    }
    return tasksOnMap.map((t) => t.id);
  }, [selectionsByMap, selectedMapId, tasksOnMap]);

  const markers = useMemo(
    () => buildObjectiveMarkers(apiTasks, selectedTaskIds, selectedMap, myProfile),
    [apiTasks, selectedTaskIds, selectedMap, myProfile]
  );

  // Extract markers from our hand-maintained EMAPS entries (the tarkov.dev
  // API doesn't expose extract positions). Skip coop-only extracts (not
  // usable in PvE) and any entry whose `pct` is null.
  const extractMarkers = useMemo(() => {
    if (!selectedMap) return [];
    const em = EMAPS.find((e) => e.id === selectedMap.normalizedName);
    if (!em) return [];
    const out = [];
    if (extractFactions.pmc) {
      for (const ex of em.pmcExtracts || []) {
        if (ex.type === "coop" || !ex.pct) continue;
        out.push({ ...ex, faction: "pmc", color: EXTRACT_COLOR_PMC });
      }
    }
    if (extractFactions.scav) {
      for (const ex of em.scavExtracts || []) {
        if (ex.type === "coop" || !ex.pct) continue;
        out.push({ ...ex, faction: "scav", color: EXTRACT_COLOR_SCAV });
      }
    }
    return out;
  }, [selectedMap, extractFactions]);

  // ── Leaflet map init ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || leafletMapRef.current) return;
    const map = L.map(mapContainerRef.current, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 4,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      attributionControl: false,
      zoomControl: true,
      maxBounds: [[-100, -100], [1100, 1100]],
      maxBoundsViscosity: 0.8,
    });
    map.fitBounds([[0, 0], [1000, 1000]]);
    leafletMapRef.current = map;
    markersLayerRef.current = L.layerGroup().addTo(map);
    const id = setTimeout(() => map.invalidateSize(), 100);
    return () => {
      clearTimeout(id);
      map.remove();
      leafletMapRef.current = null;
      markersLayerRef.current = null;
      imageOverlayRef.current = null;
    };
  }, []);

  // Swap the SVG image overlay when the map selection changes.
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    if (imageOverlayRef.current) {
      map.removeLayer(imageOverlayRef.current);
      imageOverlayRef.current = null;
    }
    if (!selectedMap) return;
    const svgName = MAP_SVG_NAMES[selectedMap.normalizedName];
    if (!svgName) return;
    const url = `https://assets.tarkov.dev/maps/svg/${svgName}.svg`;
    imageOverlayRef.current = L.imageOverlay(url, [[0, 0], [1000, 1000]]).addTo(map);
    map.fitBounds([[0, 0], [1000, 1000]]);
  }, [selectedMap]);

  // Redraw chits whenever the marker list changes.
  useEffect(() => {
    const layer = markersLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const toLL = (pct) => [(1 - pct.y) * 1000, pct.x * 1000];
    const esc = (s) => String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    for (const m of markers) {
      const size = 20;
      const opacity = m.complete ? 0.4 : 1;
      const html = `<div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:${m.color};border:2px solid rgba(0,0,0,0.7);
        display:flex;align-items:center;justify-content:center;
        font-size:${size - 8}px;line-height:1;opacity:${opacity};
        box-shadow:0 0 4px rgba(0,0,0,0.6);
        color:#0d0e10;font-weight:bold;">${m.glyph}</div>`;
      const icon = L.divIcon({
        html,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const marker = L.marker(toLL(m.pct), { icon });
      const progressLine = m.progressTotal > 1
        ? `<div style="color:${T.textDim};font-size:10px;margin-top:2px">${m.progressDone}/${m.progressTotal}</div>`
        : "";
      const completeLine = m.complete
        ? `<div style="color:${T.success};font-size:10px;margin-top:2px">✓ Complete</div>`
        : "";
      const optionalLine = m.optional
        ? `<div style="color:${T.textDim};font-size:10px">optional</div>`
        : "";
      marker.bindPopup(
        `<div style="max-width:200px">
          <div style="color:${m.color};font-weight:bold;margin-bottom:3px">${esc(m.taskName)}</div>
          <div style="color:${T.textBright}">${esc(m.description)}</div>
          ${progressLine}${completeLine}${optionalLine}
        </div>`,
        { className: "tg-taskmap-popup", closeButton: false, autoPan: false, maxWidth: 220 }
      );
      layer.addLayer(marker);
    }

    // Extract markers: diamond icon with the extract name as a pill above.
    // divIcon is sized so the diamond's centre sits exactly on the coords
    // and the label floats above it, sharing the same anchor point.
    for (const ex of extractMarkers) {
      const diamondSize = 14;
      const totalHeight = diamondSize + 18; // label ≈ 14px + margin
      const iconWidth = 120; // wide enough that long names don't clip
      const html = `<div style="
        display:flex;flex-direction:column;align-items:center;
        width:${iconWidth}px;pointer-events:none;">
        <div style="
          background:rgba(13,17,23,0.92);color:${ex.color};
          padding:1px 5px;font-size:10px;font-family:${T.sans};
          white-space:nowrap;border-radius:3px;
          border:1px solid ${ex.color}66;
          box-shadow:0 1px 3px rgba(0,0,0,0.6);
          margin-bottom:2px;pointer-events:auto;">${esc(ex.name)}</div>
        <div style="
          width:${diamondSize}px;height:${diamondSize}px;
          background:${ex.color};border:2px solid rgba(0,0,0,0.7);
          transform:rotate(45deg);box-shadow:0 0 4px rgba(0,0,0,0.6);
          pointer-events:auto;"></div>
      </div>`;
      const icon = L.divIcon({
        html,
        className: "",
        iconSize: [iconWidth, totalHeight],
        // Anchor the diamond's centre, not the container's — label floats above.
        iconAnchor: [iconWidth / 2, totalHeight - diamondSize / 2],
      });
      const marker = L.marker(toLL(ex.pct), { icon });
      const factionLabel = ex.faction === "pmc" ? "▲ PMC" : "◆ SCAV";
      const typeLine = ex.note
        ? `<div style="color:${T.textDim};font-size:10px;margin-top:2px">${esc(ex.note)}</div>`
        : "";
      marker.bindPopup(
        `<div style="max-width:200px">
          <div style="color:${ex.color};font-weight:bold;margin-bottom:3px">${esc(ex.name)}</div>
          <div style="color:${T.textBright};font-size:10px">${factionLabel} · ${esc(ex.type)}</div>
          ${typeLine}
        </div>`,
        { className: "tg-taskmap-popup", closeButton: false, autoPan: false, maxWidth: 220 }
      );
      layer.addLayer(marker);
    }
  }, [markers, extractMarkers]);

  // ── UI handlers ──────────────────────────────────────────────────────
  const toggleTask = (taskId) => {
    if (!selectedMapId) return;
    setSelectionsByMap((prev) => {
      const current = Array.isArray(prev[selectedMapId])
        ? prev[selectedMapId]
        : tasksOnMap.map((t) => t.id);
      const set = new Set(current);
      if (set.has(taskId)) set.delete(taskId); else set.add(taskId);
      return { ...prev, [selectedMapId]: Array.from(set) };
    });
  };
  const selectAll = () => {
    if (!selectedMapId) return;
    setSelectionsByMap((prev) => ({ ...prev, [selectedMapId]: tasksOnMap.map((t) => t.id) }));
  };
  const selectNone = () => {
    if (!selectedMapId) return;
    setSelectionsByMap((prev) => ({ ...prev, [selectedMapId]: [] }));
  };

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div style={{
      background: T.bg,
      color: T.text,
      fontFamily: T.sans,
      height: "100vh",
      width: "100vw",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      userSelect: "none",
      boxSizing: "border-box",
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 6px",
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
      }}>
        <select
          value={selectedMapId || ""}
          onChange={(e) => setSelectedMapId(e.target.value || null)}
          title="Choose which map to display. Only maps supported by Tarkov Planner appear in this list."
          disabled={loading || !sortedMaps.length}
          style={{
            flex: 1,
            minWidth: 0,
            background: T.inputBg,
            border: `1px solid ${T.border}`,
            color: T.textBright,
            fontSize: T.fs1,
            padding: "4px 6px",
            fontFamily: T.sans,
            borderRadius: T.r1,
            outline: "none",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading && <option value="">Loading…</option>}
          {!loading && !sortedMaps.length && <option value="">No maps</option>}
          {!loading && sortedMaps.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>

        <div style={{ position: "relative", flex: 1, minWidth: 0 }} ref={tasksBtnRef}>
          <button
            onClick={() => setTasksOpen((v) => !v)}
            title="Choose which of your active tasks to show on this map. Only tasks with mappable objectives on the current map appear here."
            disabled={!selectedMap || !tasksOnMap.length}
            style={{
              width: "100%",
              background: T.inputBg,
              border: `1px solid ${T.border}`,
              color: tasksOnMap.length ? T.textBright : T.textDim,
              fontSize: T.fs1,
              padding: "4px 6px",
              fontFamily: T.sans,
              borderRadius: T.r1,
              cursor: tasksOnMap.length ? "pointer" : "default",
              textAlign: "left",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            Tasks ({selectedTaskIds.length}/{tasksOnMap.length}) ▾
          </button>
          {tasksOpen && (
            <div style={{
              position: "absolute",
              top: "100%",
              right: 0,
              left: 0,
              zIndex: 1000,
              marginTop: 2,
              background: T.surface,
              border: `1px solid ${T.border}`,
              borderRadius: T.r1,
              maxHeight: 320,
              overflowY: "auto",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            }}>
              {/* Sticky header: extracts toggles + tasks all/none. */}
              <div style={{
                position: "sticky",
                top: 0,
                background: T.surface,
                zIndex: 2,
                borderBottom: `1px solid ${T.border}`,
              }}>
                <div style={{ padding: "4px 8px 6px", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{
                    fontSize: 10, color: T.textDim, letterSpacing: 1,
                    marginBottom: 4, fontFamily: T.sans,
                  }}>EXTRACTS</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[
                      { key: "pmc", label: "▲ PMC", color: EXTRACT_COLOR_PMC,
                        title: "Show PMC extracts on the current map. Name labels float above each extract; click for details." },
                      { key: "scav", label: "◆ SCAV", color: EXTRACT_COLOR_SCAV,
                        title: "Show SCAV extracts on the current map. Name labels float above each extract; click for details." },
                    ].map(({ key, label, color, title }) => {
                      const active = extractFactions[key];
                      return (
                        <button
                          key={key}
                          onClick={() =>
                            setExtractFactions((prev) => ({ ...prev, [key]: !prev[key] }))
                          }
                          title={title}
                          style={{
                            flex: 1,
                            background: active ? `${color}22` : "transparent",
                            border: `1px solid ${active ? color : T.border}`,
                            color: active ? color : T.textDim,
                            fontSize: 10,
                            padding: "4px 6px",
                            cursor: "pointer",
                            fontFamily: T.sans,
                            borderRadius: T.r1,
                            letterSpacing: 0.5,
                          }}
                        >{label}</button>
                      );
                    })}
                  </div>
                </div>
                <div style={{
                  display: "flex", gap: 4, padding: 4, alignItems: "center",
                }}>
                  <div style={{
                    fontSize: 10, color: T.textDim, letterSpacing: 1,
                    padding: "0 4px", fontFamily: T.sans, flexShrink: 0,
                  }}>TASKS</div>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={selectAll}
                    title="Select every active task that has objectives on this map."
                    style={{
                      background: "transparent",
                      border: `1px solid ${T.border}`, color: T.textDim,
                      fontSize: 10, padding: "3px 8px",
                      cursor: "pointer", fontFamily: T.sans,
                      borderRadius: T.r1,
                    }}
                  >All</button>
                  <button
                    onClick={selectNone}
                    title="Clear all task selections for this map. Chits disappear from the map."
                    style={{
                      background: "transparent",
                      border: `1px solid ${T.border}`, color: T.textDim,
                      fontSize: 10, padding: "3px 8px",
                      cursor: "pointer", fontFamily: T.sans,
                      borderRadius: T.r1,
                    }}
                  >None</button>
                </div>
              </div>
              {tasksOnMap.length === 0 && (
                <div style={{ padding: 10, fontSize: T.fs1, color: T.textDim, textAlign: "center" }}>
                  No active tasks on this map.
                </div>
              )}
              {tasksOnMap.map((t) => {
                const selected = selectedTaskIds.includes(t.id);
                const c = taskColor(t.id);
                return (
                  <div
                    key={t.id}
                    onClick={() => toggleTask(t.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 8px",
                      cursor: "pointer",
                      fontSize: T.fs1,
                      color: selected ? T.textBright : T.textDim,
                      background: selected ? T.goldBgSubtle : "transparent",
                      borderBottom: `1px solid ${T.border}`,
                    }}
                  >
                    <span style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: c,
                      opacity: selected ? 1 : 0.35,
                      flexShrink: 0,
                      border: "1px solid rgba(0,0,0,0.4)",
                    }} />
                    <span style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>{t.name}</span>
                    <span style={{
                      flexShrink: 0,
                      color: selected ? T.gold : "transparent",
                      fontSize: 10,
                      fontWeight: "bold",
                      marginLeft: 4,
                    }}>✓</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Map body */}
      <div style={{ flex: 1, position: "relative", background: T.bg, minHeight: 0 }}>
        <div ref={mapContainerRef} style={{ position: "absolute", inset: 0 }} />

        {loading && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: T.textDim, fontSize: T.fs1,
            background: "rgba(13,14,16,0.85)",
            pointerEvents: "none",
          }}>
            Loading map data…
          </div>
        )}

        {apiError && !loading && (
          <div style={{
            position: "absolute", top: 8, left: 8, right: 8,
            padding: "6px 8px",
            fontSize: T.fs1, color: T.error,
            background: T.errorBg,
            border: `1px solid ${T.errorBorder}`,
            borderRadius: T.r1,
          }}>
            Couldn't load task/map data: {apiError}
          </div>
        )}

        {!loading && !apiError && selectedMap && markers.length === 0 && (
          <div style={{
            position: "absolute", bottom: 8, left: 8, right: 8,
            padding: "6px 8px",
            fontSize: T.fs1, color: T.textDim,
            background: "rgba(26,25,23,0.9)",
            border: `1px solid ${T.border}`,
            borderRadius: T.r1,
            pointerEvents: "none",
          }}>
            {activeTaskIds.length === 0
              ? "No active tasks yet. Scan logs or add tasks to see chits on the map."
              : tasksOnMap.length === 0
                ? `None of your active tasks have mappable objectives on ${selectedMap.name}.`
                : "Open the Tasks dropdown and pick which to display."}
          </div>
        )}
      </div>
    </div>
  );
}
