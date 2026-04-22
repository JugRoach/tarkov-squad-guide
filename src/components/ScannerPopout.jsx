import { useEffect, useState } from "react";
import { T } from "../theme.js";
import { useScanAndFetch } from "../hooks/useScanAndFetch.js";
import { useIconIndex } from "../hooks/useIconIndex.js";
import { DEFAULT_SCANNER_THRESHOLD } from "../constants.js";

const FLEA_UNLOCK_LEVEL = 15;

function formatPrice(price) {
  if (!price && price !== 0) return "—";
  if (Math.abs(price) >= 1000) return Math.round(price / 100) / 10 + "k₽";
  return price.toLocaleString() + "₽";
}

// Subscribe to the profile stored in localStorage by the main window so the
// scanner popout can honor the user's pickup threshold + PMC level without
// a prop drill (the popout lives in a separate Tauri webview).
function useProfileSettings() {
  const [settings, setSettings] = useState({ threshold: DEFAULT_SCANNER_THRESHOLD, pmcLevel: 1 });
  useEffect(() => {
    const refresh = () => {
      try {
        const raw = localStorage.getItem("tg-myprofile-v3");
        if (!raw) return;
        const p = JSON.parse(raw);
        const threshold = typeof p?.scannerThreshold === "number" ? p.scannerThreshold : DEFAULT_SCANNER_THRESHOLD;
        const pmcLevel = typeof p?.pmcLevel === "number" ? p.pmcLevel : 1;
        setSettings({ threshold, pmcLevel });
      } catch (_) {}
    };
    refresh();
    const handler = (e) => { if (!e.key || e.key === "tg-myprofile-v3") refresh(); };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  return settings;
}

export default function ScannerPopout() {
  // Popout shares localStorage with the main window, so the icon index
  // built there is reused here without a re-download.
  const { index: iconIndex, status: iconStatus, progress: iconProgress } = useIconIndex({ autoBuild: true });
  const { scanning, scanStatus, item, dbLoading, toggleScanning } = useScanAndFetch({ autoStart: true, iconIndex });
  const { threshold, pmcLevel } = useProfileSettings();

  // Exclude flea from bestSell — the left column already shows flea on its
  // own line, so this slot must always be the best *trader* offer (otherwise
  // when flea wins, both lines render the flea entry with vendor "Flea Market").
  const bestSell = item?.sellFor
    ?.filter((s) => s.priceRUB > 0 && s.vendor?.name !== "Flea Market")
    .sort((a, b) => b.priceRUB - a.priceRUB)[0];
  const fleaPrice = item?.avg24hPrice || 0;
  const slots = (item?.width || 1) * (item?.height || 1);
  const change = item?.changeLast48hPercent;

  const canUseFlea = pmcLevel >= FLEA_UNLOCK_LEVEL;
  const fleaEligible = canUseFlea ? fleaPrice : 0;
  const bestSellRUB = bestSell?.priceRUB || 0;
  const bestRUB = Math.max(bestSellRUB, fleaEligible);
  const perSlot = bestRUB ? Math.round(bestRUB / slots) : null;
  const bestSource =
    bestRUB === 0 ? null :
    bestSellRUB > fleaEligible ? (bestSell?.vendor?.name || "Trader") :
    "Flea";

  const hasVerdict = item && perSlot != null;
  const above = hasVerdict && perSlot >= threshold;
  const verdictColor = !hasVerdict ? null : above ? T.success : T.error;
  const verdictSymbol = !hasVerdict ? "" : above ? "✓" : "✗";

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
      borderLeft: `3px solid ${verdictColor || "transparent"}`,
    }}>
      {/* Header bar — scan status + controls (slimmer) */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 6px",
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
      }}>
        <button
          onClick={toggleScanning}
          disabled={dbLoading}
          style={{
            background: scanning ? T.cyanBg : "rgba(210,175,120,0.06)",
            border: `1px solid ${scanning ? T.cyan : T.border}`,
            color: scanning ? T.cyan : T.textDim,
            padding: "0 7px",
            fontSize: T.fs1,
            fontFamily: T.sans,
            cursor: dbLoading ? "wait" : "pointer",
            borderRadius: T.r1,
            fontWeight: scanning ? "bold" : "normal",
            whiteSpace: "nowrap",
            flexShrink: 0,
            lineHeight: 1.6,
          }}
        >
          {dbLoading ? "..." : scanning ? "■" : "▶"}
        </button>
        <div style={{
          flex: 1,
          fontSize: T.fs1,
          color: scanning ? T.cyan : T.textDim,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {dbLoading
            ? "Loading..."
            : iconStatus === "building"
              ? `Icons ${iconProgress.done}/${iconProgress.total}`
              : scanStatus || (scanning ? "Scanning..." : "Paused")}
        </div>
      </div>

      {/* Item result — low-profile. Left-edge border color is the primary
          pickup/skip signal; the inline verdict glyph is a smaller backup
          cue so it doesn't dominate the card. */}
      <div style={{ flex: 1, padding: "4px 7px", overflow: "hidden" }}>
        {item ? (
          <div>
            {/* Name + mini icon + verdict glyph on one row */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              {item.gridImageLink && (
                <img
                  src={item.gridImageLink}
                  alt=""
                  style={{ width: 24, height: 24, objectFit: "contain", flexShrink: 0, opacity: 0.85 }}
                />
              )}
              <div style={{
                flex: 1,
                minWidth: 0,
                fontSize: T.fs3,
                color: T.textBright,
                fontWeight: "bold",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
                {item.shortName}
              </div>
              {hasVerdict && (
                <span style={{
                  color: verdictColor,
                  fontWeight: "bold",
                  fontSize: T.fs3,
                  lineHeight: 1,
                  flexShrink: 0,
                }}>{verdictSymbol}</span>
              )}
            </div>

            {/* Per-slot — the decision metric, big and colored. The source
                (Flea vs trader name) is on the same line so there's no way
                to read the number without knowing WHICH sell path produces
                it — matters most for cheap items where flea and vendor
                can differ by 10×. */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginBottom: 2 }}>
              <span style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 0.5 }}>PER/SLOT</span>
              <span style={{
                fontSize: T.fs4,
                fontWeight: "bold",
                color: verdictColor || (perSlot ? T.textBright : T.textDim),
                lineHeight: 1,
              }}>
                {perSlot ? formatPrice(perSlot) : "—"}
              </span>
              {bestSource && (
                <span style={{
                  fontSize: T.fs2,
                  color: T.gold,
                  fontWeight: "bold",
                  letterSpacing: 0.3,
                }}>
                  {bestSource === "Flea" ? "Flea" : (bestSell?.vendor?.name || "Trader")}
                </span>
              )}
              <span style={{ fontSize: T.fs1, color: T.textDim }}>({slots}s)</span>
            </div>

            {/* Prices collapsed to ONE comparison line: Flea · Trader.
                Winning source is bolded gold (same as the per-slot source
                tag above), losing source stays dim for reference. Saves a
                row over the previous stacked layout. */}
            <div style={{ fontSize: T.fs1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{
                fontWeight: bestSource === "Flea" ? "bold" : "normal",
                color: bestSource === "Flea" ? T.gold : T.textDim,
              }}>
                Flea{" "}
                <span style={{
                  color: fleaPrice
                    ? (bestSource === "Flea" ? T.gold : T.textBright)
                    : T.textDim,
                }}>
                  {formatPrice(fleaPrice)}
                </span>
                {change != null && change !== 0 && (
                  <span style={{ color: change > 0 ? T.success : T.error, marginLeft: 2 }}>
                    {change > 0 ? "+" : ""}{Math.round(change)}%
                  </span>
                )}
                {!canUseFlea && fleaPrice ? (
                  <span style={{ color: T.textDim, marginLeft: 3, fontSize: 9 }}>
                    (lv {FLEA_UNLOCK_LEVEL}+)
                  </span>
                ) : null}
              </span>
              <span style={{ color: T.textDim, margin: "0 5px" }}>·</span>
              <span style={{
                fontWeight: bestSource && bestSource !== "Flea" ? "bold" : "normal",
                color: bestSource && bestSource !== "Flea" ? T.gold : T.textDim,
              }}>
                {bestSell?.vendor?.name || "Trader"}{" "}
                <span style={{
                  color: bestSell
                    ? (bestSource && bestSource !== "Flea" ? T.gold : T.textBright)
                    : T.textDim,
                }}>
                  {bestSell ? formatPrice(bestSell.priceRUB) : "—"}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: T.textDim,
            fontSize: T.fs1,
            textAlign: "center",
            lineHeight: 1.5,
          }}>
            {dbLoading ? "Loading…" : "Hover items in Tarkov"}
          </div>
        )}
      </div>
    </div>
  );
}
