import { useState, useEffect, useRef } from "react";
import { buildIconIndex, serializeIndex, deserializeIndex, dhash } from "../lib/iconHash.js";
import { API_URL } from "../constants.js";
// Bundled precomputed index. Vite resolves the ?url import to a static
// asset; fetched lazily on mount so startup isn't blocked by the 400KB
// download (even from local disk it's best to parse off the main thread).
import BUNDLED_INDEX_URL from "../data/icon-index-v1.bin?url";

const STORAGE_KEY = "tg-icon-index-v1";
const VERSION_KEY = "tg-icon-index-version";
// Bump when the hash format changes OR to force existing caches to
// invalidate and re-seed from the newer bundled index. v2 was the
// rollover when the precompute-icons bundle landed.
const INDEX_VERSION = 2;

const ITEM_LIST_Q = `{items(gameMode:pve){id name shortName width height gridImageLink}}`;

async function fetchItemList() {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ITEM_LIST_Q }),
  });
  return (await r.json()).data?.items || [];
}

// localStorage can hold strings up to ~5MB per origin; our serialized index
// is ~400KB binary. Base64 encoding inflates to ~530KB. Safe.
function saveIndex(index) {
  const buf = serializeIndex(index);
  let bin = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  localStorage.setItem(STORAGE_KEY, btoa(bin));
  localStorage.setItem(VERSION_KEY, String(INDEX_VERSION));
}

function loadIndex() {
  try {
    const v = Number(localStorage.getItem(VERSION_KEY));
    if (v !== INDEX_VERSION) return null;
    const b64 = localStorage.getItem(STORAGE_KEY);
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return deserializeIndex(bytes.buffer);
  } catch (_) {
    return null;
  }
}

// Bundled index is resolved once and cached — every hook instance reuses
// the same promise so opening multiple windows doesn't refetch the asset.
let bundledPromise = null;
async function loadBundled() {
  if (bundledPromise) return bundledPromise;
  bundledPromise = (async () => {
    try {
      const resp = await fetch(BUNDLED_INDEX_URL);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      return deserializeIndex(buf);
    } catch (_) {
      return null;
    }
  })();
  return bundledPromise;
}

// Delta-download icons for items that appear in the current item list but
// not in the existing index. Called in the background after the initial
// load so the scanner is usable while this catches up. New-item drift
// between bundled releases is typically small (<50 items), so the delta
// fetch is fast even without waiting for a release regenerate.
async function fetchDeltaIcons(existingIndex, fetchImpl) {
  try {
    const live = await fetchItemList();
    const haveIds = new Set(existingIndex.map((r) => r.item.id));
    const missing = live.filter((i) => i.gridImageLink && i.id && !haveIds.has(i.id));
    if (!missing.length) return null;
    const added = await buildIconIndex(missing, { concurrency: 6 });
    if (!added.length) return null;
    return [...existingIndex, ...added];
  } catch (_) {
    return null;
  }
}

/**
 * Manages the icon-hash index lifecycle.
 * Priority: localStorage cache → bundled precompute → fresh build from API.
 * Exposes { index, status: 'idle'|'loading'|'building'|'ready'|'error', progress, rebuild }.
 */
export function useIconIndex({ autoBuild = true } = {}) {
  const [index, setIndex] = useState(null);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const buildingRef = useRef(false);
  const deltaRef = useRef(false);

  const rebuild = async () => {
    if (buildingRef.current) return;
    buildingRef.current = true;
    try {
      setStatus("loading");
      const items = await fetchItemList();
      setStatus("building");
      setProgress({ done: 0, total: items.length });
      const built = await buildIconIndex(items, {
        concurrency: 8,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setIndex(built);
      setStatus("ready");
      try { saveIndex(built); } catch (e) { console.warn("[iconIndex] save failed:", e); }
    } catch (e) {
      console.error("[iconIndex] build failed:", e);
      setStatus("error");
    } finally {
      buildingRef.current = false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Fast path: localStorage cache (0ms).
      const cached = loadIndex();
      if (cached?.length) {
        if (cancelled) return;
        setIndex(cached);
        setStatus("ready");
        // 3b. Delta-check against the live item list so the user picks up
        // new icons between full regenerations.
        if (!deltaRef.current) {
          deltaRef.current = true;
          const updated = await fetchDeltaIcons(cached);
          if (updated && !cancelled) {
            setIndex(updated);
            try { saveIndex(updated); } catch (_) {}
          }
        }
        return;
      }

      // 2. Bundled precompute (one fetch, ~400KB, sub-second).
      const bundled = await loadBundled();
      if (bundled?.length) {
        if (cancelled) return;
        setIndex(bundled);
        setStatus("ready");
        // Persist the bundled copy so future launches skip the asset fetch
        // AND so delta additions accumulate in the user's cache.
        try { saveIndex(bundled); } catch (_) {}
        if (!deltaRef.current) {
          deltaRef.current = true;
          const updated = await fetchDeltaIcons(bundled);
          if (updated && !cancelled) {
            setIndex(updated);
            try { saveIndex(updated); } catch (_) {}
          }
        }
        return;
      }

      // 3. Fallback: full build from tarkov.dev icon CDN.
      if (autoBuild) rebuild();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBuild]);

  return { index, status, progress, rebuild };
}
