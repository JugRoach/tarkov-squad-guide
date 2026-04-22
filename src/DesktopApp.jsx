import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { T, PLAYER_COLORS } from "./theme.js";
import { useStorage } from "./hooks/useStorage.js";
import { useUpdater } from "./hooks/useUpdater.js";
import { useProfileCloudSync } from "./hooks/useProfileCloudSync.js";
import { fetchAPI, MAPS_Q, TASKS_Q, HIDEOUT_Q, TRADERS_Q } from "./api.js";
import { DEFAULT_SCANNER_THRESHOLD } from "./constants.js";
import { EMAPS } from "./lib/mapData.js";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import WelcomeBanner from "./components/WelcomeBanner.jsx";
import { invoke as tauriInvoke, listen as tauriListen } from "./lib/tauri.js";

const TaskScannerModal = lazy(() => import("./components/TaskScannerModal.jsx"));

const TasksTab = lazy(() => import("./tabs/TasksTab.jsx"));
const RaidTab = lazy(() => import("./tabs/RaidTab.jsx"));
const BuildsTab = lazy(() => import("./tabs/BuildsTab.jsx"));
const IntelTab = lazy(() => import("./tabs/IntelTab.jsx"));
const ProfileTab = lazy(() => import("./tabs/ProfileTab.jsx"));
const PriceSearch = lazy(() => import("./components/PriceSearch.jsx"));

const NAV_ITEMS = [
  { id: "tasks", label: "Tasks", icon: "★" },
  { id: "raid", label: "Raid", icon: "▶" },
  { id: "prices", label: "Prices", icon: "₽" },
  { id: "builds", label: "Builds", icon: "⚙" },
  { id: "intel", label: "Intel", icon: "◎" },
  { id: "profile", label: "Profile", icon: "▲" },
];

function DesktopAppInner() {
  const [tab, setTab] = useState("tasks");
  const [overlayMode, setOverlayMode] = useState(false);
  const [myProfile, saveMyProfile, profileReady] = useStorage(
    "tg-myprofile-v3",
    { id: "me_" + Math.random().toString(36).slice(2, 10), name: "", color: PLAYER_COLORS[0], tasks: [], progress: {}, pmcLevel: 1, traderLevels: {}, scannerThreshold: DEFAULT_SCANNER_THRESHOLD }
  );
  const [apiMaps, setApiMaps] = useState(null);
  const [apiTasks, setApiTasks] = useState(null);
  const [apiHideout, setApiHideout] = useState(null);
  const [apiTraders, setApiTraders] = useState([]);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [apiErrorMsg, setApiErrorMsg] = useState("");
  const [hideoutLevels, saveHideoutLevels] = useStorage("tg-hideout-v1", {});
  const [hideoutTarget, saveHideoutTarget] = useStorage("tg-hideout-target-v1", null);
  const [savedBuilds, saveSavedBuilds] = useStorage("tg-builds-v1", []);
  const [pendingRouteTask, setPendingRouteTask] = useState(null);
  const [welcomed, saveWelcomed] = useStorage("tg-welcomed-v7", false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [apiRetry, setApiRetry] = useState(0);
  const [taskScannerOpen, setTaskScannerOpen] = useState(false);
  const updater = useUpdater({ autoCheck: true });

  // Auto-sync profile to Supabase — survives localStorage wipes and app
  // reinstalls. Silent no-op in web/PWA without env vars or if the
  // `user_profiles` table hasn't been migrated yet (see
  // supabase/migrations/20260422_user_profiles.sql).
  useProfileCloudSync(myProfile, saveMyProfile, profileReady);

  useEffect(() => {
    if (profileReady && !welcomed) setShowWelcome(true);
  }, [profileReady, welcomed]);

  // Ctrl+Alt+T triggers the global shortcut in Rust, which emits this
  // event back to the main window. We just open the scanner modal; the
  // modal does its own countdown + OCR trigger.
  useEffect(() => {
    let unlisten;
    (async () => {
      unlisten = await tauriListen("task-scan-start", () => setTaskScannerOpen(true));
    })();
    return () => { if (typeof unlisten === "function") unlisten(); };
  }, []);

  // Fetch API data (re-runs when apiRetry bumps)
  useEffect(() => {
    let cancelled = false;
    setApiLoading(true);
    setApiError(false);
    setApiErrorMsg("");
    (async () => {
      try {
        const [mData, tData, hData, trData] = await Promise.all([
          fetchAPI(MAPS_Q), fetchAPI(TASKS_Q), fetchAPI(HIDEOUT_Q), fetchAPI(TRADERS_Q),
        ]);
        if (cancelled) return;
        const playable = ["customs","factory","woods","interchange","shoreline","reserve","lighthouse","streets-of-tarkov","the-lab","ground-zero"];
        setApiMaps((mData?.maps || []).filter((m) => playable.includes(m.normalizedName)));
        const seenNames = new Set();
        setApiTasks((tData?.tasks || []).filter((t) => {
          const key = t.name + "|" + (t.trader?.name || "");
          if (seenNames.has(key)) return false;
          seenNames.add(key);
          return true;
        }));
        setApiHideout(hData?.hideoutStations || []);
        setApiTraders(trData?.traders || []);
      } catch (e) {
        if (cancelled) return;
        setApiError(true);
        setApiErrorMsg(String(e?.message || e) || "Unknown error");
      }
      if (!cancelled) setApiLoading(false);
    })();
    return () => { cancelled = true; };
  }, [apiRetry]);

  // Global search (tasks, maps, extracts, bosses)
  const searchResults = useMemo(() => {
    const q = searchQ.toLowerCase().trim();
    if (q.length < 2) return [];
    const results = [];
    (apiTasks || []).filter(t => t.name.toLowerCase().includes(q)).slice(0, 8).forEach(t => {
      results.push({ type: "Task", name: t.name, detail: `${t.trader?.name || ""}${t.map ? " · " + t.map.name : ""}` });
    });
    EMAPS.filter(m => m.name.toLowerCase().includes(q)).forEach(m => {
      results.push({ type: "Map", name: m.name, detail: m.tier });
    });
    EMAPS.forEach(m => {
      [...(m.pmcExtracts || []), ...(m.scavExtracts || [])].filter(e => e.name.toLowerCase().includes(q)).slice(0, 4).forEach(e => {
        results.push({ type: "Extract", name: e.name, detail: `${m.name} · ${e.type}` });
      });
    });
    (apiMaps || []).forEach(m => {
      (m.bosses || []).filter(b => b.boss?.name?.toLowerCase().includes(q)).forEach(b => {
        results.push({ type: "Boss", name: b.boss.name, detail: `${m.name} · ${Math.round((b.spawnChance || 0) * 100)}%` });
      });
    });
    return results;
  }, [searchQ, apiTasks, apiMaps]);

  const handleSearchAction = (type) => {
    if (type === "Task") setTab("tasks");
    else if (type === "Map" || type === "Extract") setTab("intel");
    setSearchOpen(false);
  };

  // Overlay toggle
  const toggleOverlay = async () => {
    const next = !overlayMode;
    try { await tauriInvoke("set_overlay_mode", { enabled: next }); } catch (_) {}
    setOverlayMode(next);
  };

  // Sidebar width
  const sideW = overlayMode ? 48 : 140;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${sideW}px 1fr`,
        height: "100vh",
        width: "100vw",
        background: T.bg,
        color: T.text,
        fontFamily: T.sans,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {showWelcome && (
        <WelcomeBanner onDismiss={() => { setShowWelcome(false); saveWelcomed(true); }} />
      )}

      {searchOpen && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(13,14,16,0.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", zIndex: 100, display: "flex", flexDirection: "column", padding: 14 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") setSearchOpen(false); }}
              autoFocus
              placeholder="Search tasks, maps, extracts, bosses..."
              style={{ flex: 1, background: T.surface, border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "10px 12px", fontSize: T.fs3, fontFamily: T.sans, outline: "none" }}
            />
            <button onClick={() => setSearchOpen(false)} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "10px 14px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans }}>ESC</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {searchQ.trim().length < 2 && <div style={{ color: T.textDim, fontSize: T.fs3, textAlign: "center", padding: 20 }}>Type at least 2 characters to search</div>}
            {searchQ.trim().length >= 2 && searchResults.length === 0 && <div style={{ color: T.textDim, fontSize: T.fs3, textAlign: "center", padding: 20 }}>No results for "{searchQ}"</div>}
            {searchResults.map((r, i) => (
              <button key={i} onClick={() => handleSearchAction(r.type)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${r.type === "Task" ? T.gold : r.type === "Map" ? T.blue : r.type === "Boss" ? T.error : T.success}`, padding: "10px 12px", marginBottom: 4, cursor: "pointer", textAlign: "left" }}>
                <div>
                  <div style={{ color: T.textBright, fontSize: T.fs3, fontWeight: "bold" }}>{r.name}</div>
                  <div style={{ color: T.textDim, fontSize: T.fs1, marginTop: 2 }}>{r.detail}</div>
                </div>
                <span style={{ fontSize: T.fs1, color: T.textDim, fontFamily: T.sans, letterSpacing: 1 }}>{r.type.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── SIDEBAR NAV ─────────────────────────────── */}
      <nav
        style={{
          display: "flex",
          flexDirection: "column",
          background: T.surface,
          borderRight: `1px solid ${T.border}`,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: overlayMode ? "8px 4px" : "12px 10px 8px",
            borderBottom: `1px solid ${T.border}`,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: overlayMode ? T.fs1 : T.fs3, fontWeight: "bold", color: T.gold, letterSpacing: 1.5 }}>
            {overlayMode ? "TG" : "TARKOV"}
          </div>
          {!overlayMode && (
            <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 2, marginTop: 2 }}>GUIDE</div>
          )}
        </div>

        {/* Search button */}
        <button
          onClick={() => { setSearchOpen(true); setSearchQ(""); }}
          title="Search tasks, maps, extracts, bosses"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: overlayMode ? "10px 0" : "10px 12px",
            justifyContent: overlayMode ? "center" : "flex-start",
            background: "transparent",
            border: "none",
            borderLeft: "3px solid transparent",
            borderBottom: `1px solid ${T.border}`,
            cursor: "pointer",
            color: T.textDim,
            fontFamily: T.sans,
            fontSize: T.fs2,
            letterSpacing: 0.5,
            width: "100%",
          }}
        >
          <span style={{ fontSize: T.fs4, flexShrink: 0 }}>🔍</span>
          {!overlayMode && <span style={{ textTransform: "uppercase" }}>Search</span>}
        </button>

        {/* Nav items */}
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: overlayMode ? "10px 0" : "10px 12px",
              justifyContent: overlayMode ? "center" : "flex-start",
              background: tab === item.id ? "rgba(210,175,120,0.1)" : "transparent",
              border: "none",
              borderLeft: `3px solid ${tab === item.id ? T.gold : "transparent"}`,
              cursor: "pointer",
              color: tab === item.id ? T.gold : T.textDim,
              fontFamily: T.sans,
              fontSize: T.fs2,
              fontWeight: tab === item.id ? "bold" : "normal",
              letterSpacing: 0.5,
              transition: "all 0.15s ease",
              width: "100%",
            }}
          >
            <span style={{ fontSize: T.fs4, flexShrink: 0 }}>{item.icon}</span>
            {!overlayMode && <span style={{ textTransform: "uppercase" }}>{item.label}</span>}
          </button>
        ))}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Status + Overlay toggle */}
        <div style={{ padding: overlayMode ? "8px 4px" : "8px 10px", borderTop: `1px solid ${T.border}` }}>
          {!overlayMode && (
            <div
              style={{
                fontSize: T.fs1,
                color: apiError ? T.error : T.success,
                display: "flex",
                alignItems: "center",
                gap: 4,
                marginBottom: 8,
              }}
            >
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: apiError ? T.error : T.success }} />
              {apiError ? "OFFLINE" : "LIVE"}
            </div>
          )}
          <button
            onClick={toggleOverlay}
            title={overlayMode ? "Exit overlay (Alt+O)" : "Overlay mode — always on top"}
            style={{
              width: "100%",
              padding: "6px 0",
              background: overlayMode ? "rgba(210,175,120,0.15)" : "rgba(210,175,120,0.06)",
              border: `1px solid ${overlayMode ? T.gold : T.border}`,
              color: overlayMode ? T.gold : T.textDim,
              fontSize: T.fs1,
              fontFamily: T.sans,
              cursor: "pointer",
              borderRadius: T.r1,
              letterSpacing: 1,
            }}
          >
            {overlayMode ? "EXIT" : "OVR"}
          </button>
        </div>
      </nav>

      {/* ─── CONTENT AREA ────────────────────────────── */}
      <main style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {updater.status === "available" && updater.info && (
          <div style={{
            background: T.cyanBg,
            borderBottom: `1px solid ${T.cyan}`,
            color: T.cyan,
            padding: "6px 12px",
            fontSize: T.fs1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexShrink: 0,
          }}>
            <span>
              <strong>Update available:</strong> v{updater.info.version}
              <button
                onClick={() => setTab("profile")}
                style={{
                  background: "transparent", border: "none", color: T.cyan,
                  cursor: "pointer", fontSize: T.fs1, padding: "0 0 0 8px",
                  textDecoration: "underline", fontFamily: T.sans,
                }}
              >
                View release notes
              </button>
            </span>
            <button
              onClick={updater.installUpdate}
              style={{
                background: T.cyan, border: "none", color: T.bg,
                padding: "3px 12px", fontSize: T.fs1, fontFamily: T.sans,
                cursor: "pointer", borderRadius: T.r1, letterSpacing: 0.5,
                whiteSpace: "nowrap", fontWeight: "bold",
              }}
            >
              INSTALL &amp; RELAUNCH
            </button>
          </div>
        )}
        {updater.status === "downloading" && (
          <div style={{
            background: T.cyanBg,
            borderBottom: `1px solid ${T.cyan}`,
            color: T.cyan,
            padding: "6px 12px",
            fontSize: T.fs1,
            flexShrink: 0,
          }}>
            Downloading update… {Math.round(updater.progress * 100)}%
            <div style={{ height: 3, background: T.border, marginTop: 4, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${updater.progress * 100}%`, background: T.cyan, transition: "width 0.2s" }} />
            </div>
          </div>
        )}
        {apiError && (
          <div style={{
            background: T.errorBg || "rgba(200,80,80,0.08)",
            borderBottom: `1px solid ${T.error}`,
            color: T.error,
            padding: "6px 12px",
            fontSize: T.fs1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexShrink: 0,
          }}>
            <span>
              <strong>tarkov.dev unreachable.</strong>
              {apiErrorMsg && <span style={{ color: T.textDim, marginLeft: 6 }}>{apiErrorMsg}</span>}
            </span>
            <button
              onClick={() => setApiRetry(n => n + 1)}
              disabled={apiLoading}
              style={{
                background: "transparent",
                border: `1px solid ${T.error}`,
                color: T.error,
                padding: "2px 10px",
                fontSize: T.fs1,
                fontFamily: T.sans,
                cursor: apiLoading ? "wait" : "pointer",
                borderRadius: T.r1,
                letterSpacing: 0.5,
                whiteSpace: "nowrap",
                opacity: apiLoading ? 0.6 : 1,
              }}
            >
              {apiLoading ? "RETRYING…" : "RETRY"}
            </button>
          </div>
        )}
        <Suspense
          fallback={
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: T.textDim,
                fontSize: T.fs4,
              }}
            >
              Loading...
            </div>
          }
        >
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {tab === "tasks" && (
              <TasksTab
                myProfile={myProfile}
                saveMyProfile={saveMyProfile}
                apiTasks={apiTasks}
                apiTraders={apiTraders}
                loading={apiLoading}
                apiError={apiError}
                apiHideout={apiHideout}
                hideoutLevels={hideoutLevels}
                saveHideoutLevels={saveHideoutLevels}
                hideoutTarget={hideoutTarget}
                saveHideoutTarget={saveHideoutTarget}
                onRouteTask={(taskId, mapId) => {
                  setPendingRouteTask({ taskId, mapId });
                  setTab("raid");
                }}
              />
            )}
            {tab === "raid" && (
              <RaidTab
                myProfile={myProfile}
                saveMyProfile={saveMyProfile}
                apiMaps={apiMaps}
                apiTasks={apiTasks}
                apiTraders={apiTraders}
                loading={apiLoading}
                apiError={apiError}
                hideoutTarget={hideoutTarget}
                apiHideout={apiHideout}
                hideoutLevels={hideoutLevels}
                pendingRouteTask={pendingRouteTask}
                clearPendingRouteTask={() => setPendingRouteTask(null)}
              />
            )}
            {tab === "prices" && <PriceSearch />}
            {tab === "builds" && <BuildsTab savedBuilds={savedBuilds} saveSavedBuilds={saveSavedBuilds} myProfile={myProfile} />}
            {tab === "intel" && <IntelTab />}
            {tab === "profile" && (
              <ProfileTab
                myProfile={myProfile}
                saveMyProfile={saveMyProfile}
                setTab={setTab}
                apiTasks={apiTasks}
                onOpenTaskScanner={() => setTaskScannerOpen(true)}
              />
            )}
          </div>
        </Suspense>
      </main>
      {taskScannerOpen && (
        <Suspense fallback={null}>
          <TaskScannerModal
            apiTasks={apiTasks}
            myProfile={myProfile}
            saveMyProfile={saveMyProfile}
            onClose={() => setTaskScannerOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default function DesktopApp() {
  return (
    <ErrorBoundary>
      <DesktopAppInner />
    </ErrorBoundary>
  );
}
