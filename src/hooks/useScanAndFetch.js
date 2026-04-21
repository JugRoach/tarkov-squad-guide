import { useState, useEffect, useRef, useCallback } from "react";
import { findBestMatch, buildMatchIndex, prepQuery, scoreItem } from "../lib/fuzzyMatch.js";
import { dhashFromRgba, findTopK, toneMapRgba, hammingDistance } from "../lib/iconHash.js";
import { API_URL } from "../constants.js";

const ALL_ITEMS_Q = `{items(gameMode:pve){id name shortName width height}}`;
const ITEM_PRICE_Q = (id) =>
  `{item(id:"${id}", gameMode:pve){
    id name shortName width height gridImageLink
    avg24hPrice basePrice changeLast48hPercent
    sellFor { price priceRUB currency vendor { name } }
    buyFor { price priceRUB currency vendor { ... on TraderOffer { name minTraderLevel } ... on FleaMarket { name } } }
  }}`;

async function fetchGql(query) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return (await r.json()).data;
}

function cleanOcr(raw) {
  return raw.replace(/[,.:;!|{}\[\]()]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Crop a square region centered on the cursor from the full capture.
 * Used as a fallback when the Rust-side tile detector doesn't return a
 * rect (older paths, defensive case). For 1x1 items this lines up OK;
 * multi-slot items suffer from aspect-ratio mismatch against the
 * reference icons — the rect-based crop below fixes that.
 */
function cropRgbaAroundCursor(rgba, width, height, cursorX, cursorY, cropSize) {
  const half = Math.floor(cropSize / 2);
  const sx = Math.max(0, Math.min(width - cropSize, cursorX - half));
  const sy = Math.max(0, Math.min(height - cropSize, cursorY - half));
  const out = new Uint8Array(cropSize * cropSize * 4);
  for (let y = 0; y < cropSize; y++) {
    const srcRowStart = ((sy + y) * width + sx) * 4;
    const dstRowStart = y * cropSize * 4;
    out.set(rgba.subarray(srcRowStart, srcRowStart + cropSize * 4), dstRowStart);
  }
  return { rgba: out, width: cropSize, height: cropSize };
}

/**
 * Crop the capture to the exact tile rect detected by the Rust scanner.
 * Preserves the tile's true aspect ratio — critical for multi-slot items
 * (rifles, cases) where a fixed square crop mismatches the reference
 * icon's shape and degrades dHash accuracy.
 */
function cropRgbaFromRect(rgba, width, height, rect) {
  const sx = Math.max(0, Math.min(width, rect.x | 0));
  const sy = Math.max(0, Math.min(height, rect.y | 0));
  const ex = Math.max(sx, Math.min(width, (rect.x + rect.w) | 0));
  const ey = Math.max(sy, Math.min(height, (rect.y + rect.h) | 0));
  const cw = ex - sx;
  const ch = ey - sy;
  if (cw <= 0 || ch <= 0) return null;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcRowStart = ((sy + y) * width + sx) * 4;
    const dstRowStart = y * cw * 4;
    out.set(rgba.subarray(srcRowStart, srcRowStart + cw * 4), dstRowStart);
  }
  return { rgba: out, width: cw, height: ch };
}

/**
 * Shared scan-and-fetch for PriceSearch + ScannerPopout.
 * Captures OCR at cursor via Tauri, fuzzy-matches against the item DB,
 * fetches price data, and exposes scan state + Alt+S toggle.
 *
 * Why refs everywhere: hotkey listener is registered once; it dispatches
 * through toggleRef/runScanRef so it never captures a stale closure.
 */
export function useScanAndFetch({ autoStart = false, onPrice, iconIndex = null } = {}) {
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);
  const [item, setItem] = useState(null);
  const [itemDb, setItemDb] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);

  const lastScanRef = useRef("");
  const scanCounterRef = useRef(0); // Used to sparse-run the tooltip verify pass
  const scanIntervalRef = useRef(null);
  const tauriInvokeRef = useRef(null);
  const matchIndexRef = useRef(null);
  const matchByIdRef = useRef(null); // Map<itemId, matchRow> for O(1) join with iconIndex
  const itemDbRef = useRef(null);
  const iconIndexRef = useRef(iconIndex);
  const onPriceRef = useRef(onPrice);
  const runScanRef = useRef(null);
  const toggleRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => { onPriceRef.current = onPrice; }, [onPrice]);
  useEffect(() => { iconIndexRef.current = iconIndex; }, [iconIndex]);

  // Load item DB + precompute token index
  useEffect(() => {
    mountedRef.current = true;
    fetchGql(ALL_ITEMS_Q)
      .then((data) => {
        if (!mountedRef.current) return;
        const items = data?.items || [];
        const mIndex = buildMatchIndex(items);
        matchIndexRef.current = mIndex;
        matchByIdRef.current = new Map(mIndex.map((r) => [r.item.id, r]));
        itemDbRef.current = items;
        setItemDb(items);
      })
      .catch(() => { if (mountedRef.current) setItemDb([]); })
      .finally(() => { if (mountedRef.current) setDbLoading(false); });
    return () => { mountedRef.current = false; };
  }, []);

  // Load Tauri invoke
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        tauriInvokeRef.current = invoke;
      } catch (_) {}
    })();
  }, []);

  const runScan = useCallback(async () => {
    const index = matchIndexRef.current;
    const invoke = tauriInvokeRef.current;
    if (!invoke || !index) return;
    try {
      // Run OCR + raw-pixel capture in parallel. dHash handles the
      // tooltip-overlay case where OCR sees descriptive text instead of
      // the tile label; OCR still disambiguates ammo variants that hash
      // identically. Every 4th scan (~1 Hz) also runs the wide tooltip
      // OCR pass for "verify against the full item name" — confirms or
      // corrects the fast-scan pick once the game tooltip has appeared.
      const iconIdx = iconIndexRef.current;
      const runTooltip = (scanCounterRef.current++ % 4) === 0;
      const [lines, capture, tooltipLines] = await Promise.all([
        invoke("scan_at_cursor").catch(() => null),
        iconIdx ? invoke("capture_rgba_at_cursor").catch(() => null) : Promise.resolve(null),
        runTooltip ? invoke("ocr_tooltip_region").catch(() => null) : Promise.resolve(null),
      ]);

      // Debug sentinels — show diagnostic in status line instead of matching
      const first = lines?.[0] || "";
      if (first.startsWith("__")) {
        if (!mountedRef.current) return;
        let label = first;
        if (first === "__NO_OCR__") label = "No text read at cursor";
        else if (first === "__NO_TILE__") label = "Not hovering a tile";
        setScanStatus(label);
        return;
      }

      // --- OCR candidate prep (same reordering as before)
      const preparedQueries = [];
      let primaryOcr = "";
      if (lines?.length) {
        const rawCands = lines.map(cleanOcr).filter((c) => c.length >= 2);
        if (rawCands.length) {
          // OCR splits multi-word labels like "ES Lamp" into separate
          // words; matching "Lamp" alone confidently picks "UV Lamp"
          // (fewer tokens → smaller length penalty) before the joined
          // phrase is tried. Promote 2-word phrases ahead of singles.
          const ordered = [];
          const trailing = [];
          for (const c of rawCands) {
            if (c.split(/\s+/).length === 2) ordered.push(c);
            else trailing.push(c);
          }
          ordered.push(...trailing);
          primaryOcr = ordered[0];
          for (const c of ordered) preparedQueries.push({ text: c, ...prepQuery(c) });
        }
      }

      // --- Prep tooltip verification lines separately from fast-scan
      // candidates. The short-label OCR text ("Bandage") dominates the
      // ocrScore for any sibling that shares a shortName, so just adding
      // the full-name tooltip line to preparedQueries doesn't help — it
      // caps at the same score. We'll use tooltip lines only as a
      // "has the game tooltip visibly named THIS specific item?" check,
      // below.
      const tooltipQueries = [];
      if (tooltipLines?.length) {
        for (const raw of tooltipLines) {
          const c = cleanOcr(raw);
          if (c.length < 4 || c.length > 40) continue;
          // At least half the chars should be letters — skips stat lines
          // like "650/1" or "HP restoration: 400".
          const letterCount = (c.match(/[a-zA-Z]/g) || []).length;
          if (letterCount < c.length * 0.5) continue;
          tooltipQueries.push(prepQuery(c));
        }
      }

      // --- Query hash from captured tile
      let queryHash = null;
      if (capture?.rgba && iconIdx?.length) {
        const rgbaU8 = new Uint8Array(capture.rgba);
        // Prefer the Rust-detected tile rect (preserves aspect ratio for
        // multi-slot items, matching reference icons); fall back to a
        // fixed 80px square around the cursor if detection didn't fire.
        let cropped = null;
        if (capture.tile) {
          cropped = cropRgbaFromRect(rgbaU8, capture.width, capture.height, capture.tile);
        }
        if (!cropped) {
          const cropSize = Math.min(80, capture.width, capture.height);
          cropped = cropRgbaAroundCursor(
            rgbaU8, capture.width, capture.height,
            capture.cursorX, capture.cursorY, cropSize,
          );
        }
        const { rgba: tile, width: tw, height: th } = cropped;
        // HDR captures compress the effective dynamic range — grays cluster
        // in a narrow band instead of spanning 0-255. Stretching the tile's
        // luminance histogram to the 5-95 percentile brings it back in line
        // with the SDR reference icons before dHash sees it.
        toneMapRgba(tile, tw, th);
        queryHash = dhashFromRgba(tile, tw, th);
      }

      // --- Combined scoring: iterate the icon index once, score each
      // item on both signals, pick the one that scores highest overall.
      // This is Matt's suggestion: magazines that look alike get resolved
      // by their text (30-rd vs 45-rd), bandages with identical text get
      // resolved by color, and anything with agreement on both dominates.
      //
      // Score components:
      //   iconScore = max(0, 1 - dist/60)  — saturates past distance 60,
      //     so items far in hash space contribute nothing.
      //   ocrScore  = best fuzzyMatch score across the prepared queries.
      //     0 when OCR returned nothing matchable.
      //   combined  = iconScore + ocrScore. Additive so one-signal items
      //     still rank by that signal, but two-signal items win ties.
      const matchById = matchByIdRef.current;
      const ICON_SATURATE_DIST = 60;
      const CONFIDENT_THRESHOLD = 0.75; // OCR score that still counts as "clear text"

      let best = null;
      if (queryHash && iconIdx?.length && matchById) {
        for (const row of iconIdx) {
          const mRow = matchById.get(row.item.id);
          const dist = hammingDistance(queryHash, row.hash);
          const iconScore = Math.max(0, 1 - dist / ICON_SATURATE_DIST);
          let ocrScore = 0;
          if (mRow) {
            for (const pq of preparedQueries) {
              const s = scoreItem(pq, mRow);
              if (s > ocrScore) ocrScore = s;
            }
          }
          const combined = iconScore + ocrScore;
          if (!best || combined > best.combined) {
            best = { item: mRow?.item || row.item, dist, iconScore, ocrScore, combined };
          }
        }
      } else if (preparedQueries.length && matchIndexRef.current) {
        // Icon index not ready yet — fall back to OCR-only using the
        // existing top-1 logic.
        let ocrMatch = null, ocrCand = null;
        for (const pq of preparedQueries) {
          const match = findBestMatch(pq.text, matchIndexRef.current);
          if (!match) continue;
          if (match.score >= CONFIDENT_THRESHOLD) { ocrMatch = match; ocrCand = pq.text; break; }
          if (!ocrMatch || match.score > ocrMatch.score) { ocrMatch = match; ocrCand = pq.text; }
        }
        if (ocrMatch) best = { item: ocrMatch.item, dist: null, iconScore: 0, ocrScore: ocrMatch.score, combined: ocrMatch.score, ocrCand };
      }

      // --- Tooltip verification pass
      // Uses the whole tooltip, not just one line. Matt's insight: when
      // the tooltip is up the capture region also picks up OCR text from
      // *other* nearby tiles, and just scoring one line at a time lets
      // an unrelated sibling's label (e.g. "Army cap" from an adjacent
      // tile) verify instead of the actual hovered item ("Army bandage").
      //
      // Two filters:
      //   1. Token-bag subset — every name token of the verified item
      //      must appear *somewhere* in the tooltip capture. Cross-item
      //      leakage still puts both items' tokens in the bag, so this
      //      alone can't solve it.
      //   2. shortName agreement — the verified item's shortName must
      //      match the fast-scan combined pick's shortName. The tile
      //      label OCR is reliable (it's the closest-to-cursor text and
      //      high-contrast), so combined's shortName is our ground truth
      //      for which *category* the cursor is on. Verify refines
      //      within that category (sibling disambiguation).
      let verified = null;
      const tooltipBag = new Set();
      for (const tq of tooltipQueries) {
        for (const t of tq.tokens) tooltipBag.add(t);
      }
      if (tooltipBag.size >= 2 && tooltipQueries.length && matchIndexRef.current && best?.item) {
        const categoryShortName = best.item.shortName;
        const candidateMap = new Map(); // itemId -> best {item, score}
        for (const tq of tooltipQueries) {
          for (const row of matchIndexRef.current) {
            // Only consider items in the same shortName family as the
            // fast-scan pick — prevents cross-category override.
            if (row.item.shortName !== categoryShortName) continue;
            // Subset: every token of the item's full name must appear
            // in the captured tooltip text. Ensures the tooltip actually
            // said this item's name somewhere.
            if (row.tokens.length < 2) continue;
            let allPresent = true;
            for (const t of row.tokens) if (!tooltipBag.has(t)) { allPresent = false; break; }
            if (!allPresent) continue;
            const s = scoreItem(tq, row);
            if (s >= 0.85) {
              const prev = candidateMap.get(row.item.id);
              if (!prev || s > prev.score) {
                candidateMap.set(row.item.id, { item: row.item, score: s });
              }
            }
          }
        }
        if (candidateMap.size) {
          const sorted = [...candidateMap.values()].sort((a, b) => b.score - a.score);
          // Single candidate = unambiguous sibling win. Multiple candidates
          // is rare (requires two same-shortName items to both have all
          // their name tokens in the tooltip), so treat it as a tie and
          // skip the override.
          if (sorted.length === 1 || sorted[0].score - sorted[1].score >= 0.15) {
            verified = sorted[0];
          }
        }
      }

      let chosen = null, source = null, statusText = null;
      if (verified) {
        chosen = verified.item;
        source = "verified";
        statusText = `\u2713 ${chosen.shortName} (tooltip: ${chosen.name})`;
      } else if (best) {
        chosen = best.item;
        const hasIcon = best.dist != null;
        const hasOcr = best.ocrScore >= 0.3; // weak-ish signal worth mentioning
        if (hasIcon && hasOcr) {
          source = "both";
          statusText = `${chosen.shortName} (d=${best.dist}, ocr ${Math.round(best.ocrScore * 100)}%)`;
        } else if (hasIcon) {
          source = "icon";
          statusText = `${chosen.shortName} (icon d=${best.dist})`;
        } else {
          source = "ocr";
          statusText = `${chosen.shortName} (ocr ${Math.round(best.ocrScore * 100)}%)`;
        }
        // Reject low-confidence results — saves us from spurious matches
        // when neither OCR nor dHash see anything real (e.g. cursor on
        // empty space). 0.5 combined roughly means "one signal is
        // strong OR both signals are weakly present".
        if (best.combined < 0.5) chosen = null;
      }

      // Cache key to skip redundant fetches for the same result
      const cacheKey = chosen ? `${source}:${chosen.id}` : `nomatch:${primaryOcr}`;
      if (cacheKey === lastScanRef.current) return;
      lastScanRef.current = cacheKey;

      if (!mountedRef.current) return;
      if (chosen) {
        setScanStatus(statusText);
        const priced = await fetchGql(ITEM_PRICE_Q(chosen.id));
        if (!mountedRef.current) return;
        if (priced?.item) {
          setItem(priced.item);
          onPriceRef.current?.(priced.item, chosen);
        }
      } else {
        setScanStatus(primaryOcr ? `No match: "${primaryOcr}"` : "No match");
      }
    } catch (_) {}
  }, []);

  useEffect(() => { runScanRef.current = runScan; }, [runScan]);

  const toggleScanning = useCallback(() => {
    setScanning((prev) => {
      const next = !prev;
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
      if (next) {
        lastScanRef.current = "";
        runScanRef.current?.();
        scanIntervalRef.current = setInterval(() => runScanRef.current?.(), 250);
      } else {
        setScanStatus(null);
      }
      return next;
    });
  }, []);

  useEffect(() => { toggleRef.current = toggleScanning; }, [toggleScanning]);

  // Auto-start once DB + Tauri are ready
  useEffect(() => {
    if (!autoStart || dbLoading || !itemDb?.length || scanning) return;
    if (!window.__TAURI_INTERNALS__) return;
    // Wait a tick for tauriInvoke to load
    const t = setTimeout(() => {
      if (tauriInvokeRef.current && !scanning) toggleRef.current?.();
    }, 50);
    return () => clearTimeout(t);
  }, [autoStart, dbLoading, itemDb, scanning]);

  // Register Alt+S hotkey exactly once; cleanup handles in-flight setup
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten = null;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const fn = await listen("toggle-scan", () => toggleRef.current?.());
        if (cancelled) fn();
        else unlisten = fn;
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Unmount: clear interval + mark unmounted
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    };
  }, []);

  return { scanning, scanStatus, item, itemDb, dbLoading, toggleScanning };
}
