import { useState, useEffect, useRef, useCallback } from "react";
import { findBestMatch, buildMatchIndex } from "../lib/fuzzyMatch.js";
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
 * Shared scan-and-fetch for PriceSearch + ScannerPopout.
 * Captures OCR at cursor via Tauri, fuzzy-matches against the item DB,
 * fetches price data, and exposes scan state + Alt+S toggle.
 *
 * Why refs everywhere: hotkey listener is registered once; it dispatches
 * through toggleRef/runScanRef so it never captures a stale closure.
 */
export function useScanAndFetch({ autoStart = false, onPrice } = {}) {
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);
  const [item, setItem] = useState(null);
  const [itemDb, setItemDb] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);

  const lastScanRef = useRef("");
  const scanIntervalRef = useRef(null);
  const tauriInvokeRef = useRef(null);
  const matchIndexRef = useRef(null);
  const onPriceRef = useRef(onPrice);
  const runScanRef = useRef(null);
  const toggleRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => { onPriceRef.current = onPrice; }, [onPrice]);

  // Load item DB + precompute token index
  useEffect(() => {
    mountedRef.current = true;
    fetchGql(ALL_ITEMS_Q)
      .then((data) => {
        if (!mountedRef.current) return;
        const items = data?.items || [];
        matchIndexRef.current = buildMatchIndex(items);
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
    if (!tauriInvokeRef.current || !index) return;
    try {
      const lines = await tauriInvokeRef.current("scan_at_cursor");
      if (!lines || lines.length === 0) return;

      const raw = lines.join(" ").trim();
      const cleaned = cleanOcr(raw);
      if (cleaned === lastScanRef.current || cleaned.length < 2) return;
      lastScanRef.current = cleaned;

      let bestMatch = findBestMatch(cleaned, index);
      if (!bestMatch) {
        const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);
        words.sort((a, b) => b.length - a.length);
        for (const word of words) {
          const match = findBestMatch(word, index);
          if (match && (!bestMatch || match.score > bestMatch.score)) {
            bestMatch = match;
          }
        }
      }

      if (!mountedRef.current) return;
      if (bestMatch) {
        const { item: matched, score } = bestMatch;
        setScanStatus(`"${cleaned}" \u2192 ${matched.shortName} (${Math.round(score * 100)}%)`);
        const priced = await fetchGql(ITEM_PRICE_Q(matched.id));
        if (!mountedRef.current) return;
        if (priced?.item) {
          setItem(priced.item);
          onPriceRef.current?.(priced.item, matched);
        }
      } else {
        setScanStatus(`No match: "${cleaned}"`);
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
        scanIntervalRef.current = setInterval(() => runScanRef.current?.(), 750);
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
