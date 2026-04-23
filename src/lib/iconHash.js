/**
 * dHash-based icon recognition for Tarkov items.
 *
 * Hash: 17x16 grayscale → row-wise difference → 256 bits stored as
 * Uint32Array(8). Node-prototype tests on the full 4848-item DB:
 *   - 95.4% top-1 perfect recall (collisions = visually-identical ammo)
 *   - 94% top-5 recall under 5px crop noise
 *   - ~0.7ms to hash one icon
 *
 * The 2-5% true collisions (ammo variants with identical artwork + tiny
 * text labels that vanish at hash resolution) are broken by returning
 * top-K candidates so OCR / context can disambiguate.
 */

const HASH_W = 17;
const HASH_H = 16;
const HASH_BITS = HASH_W * HASH_H - HASH_H; // 256 (row-wise diffs)
const HASH_WORDS = 8; // 256 / 32

/** Draw an image into a canvas and return the 17x16 grayscale buffer. */
function toGrayResized(source) {
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(HASH_W, HASH_H)
    : Object.assign(document.createElement("canvas"), { width: HASH_W, height: HASH_H });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, HASH_W, HASH_H);
  const { data } = ctx.getImageData(0, 0, HASH_W, HASH_H);
  const gray = new Uint8Array(HASH_W * HASH_H);
  for (let i = 0; i < gray.length; i++) {
    const idx = i * 4;
    gray[i] = (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * Compute 256-bit dHash of an ImageBitmap / HTMLImageElement / HTMLCanvasElement.
 * Returns Uint32Array(8).
 */
export function dhash(source) {
  const gray = toGrayResized(source);
  const hash = new Uint32Array(HASH_WORDS);
  let bit = 0;
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      if (gray[y * HASH_W + x] < gray[y * HASH_W + x + 1]) {
        hash[bit >> 5] |= 1 << (bit & 31);
      }
      bit++;
    }
  }
  return hash;
}

/** Compute dHash from raw RGBA pixels (Rust capture path). */
export function dhashFromRgba(rgba, width, height) {
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);
  return dhash(canvas);
}

/**
 * Luminance-based tone map to the 5th–95th percentile range. Brings an
 * HDR-captured tile back into the SDR [0,255] grayscale range so dHash
 * can compare against tarkov.dev reference icons (which are pristine SDR)
 * on equal footing. Scales each channel by the luminance ratio, preserving
 * hue and — critically — preserving the rank-order of grayscale values
 * that dHash relies on. Per-channel stretching would flip the rank for
 * saturated colors and randomly corrupt the hash.
 *
 * Runs in-place on `rgba`. Alpha is preserved.
 */
export function toneMapRgba(rgba, width, height) {
  const n = width * height;
  if (n === 0) return rgba;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const g = ((rgba[idx] * 299 + rgba[idx + 1] * 587 + rgba[idx + 2] * 114) / 1000) | 0;
    gray[i] = g;
    hist[g]++;
  }
  const loTarget = Math.max(1, (n / 20) | 0);
  const hiTarget = n - loTarget;
  let lo = 0, hi = 255, acc = 0, loSet = false;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!loSet && acc >= loTarget) { lo = v; loSet = true; }
    if (acc >= hiTarget) { hi = v; break; }
  }
  // Widen when the histogram is nearly uniform — otherwise we'd map a flat
  // region into pure black/white which adds noise instead of removing it.
  if (hi - lo < 40) { lo = Math.max(0, lo - 20); hi = Math.min(255, hi + 20); }
  const range = Math.max(1, hi - lo);

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const oldG = gray[i];
    const newG = Math.max(0, Math.min(255, (((oldG - lo) * 255) / range) | 0));
    if (oldG === 0) {
      rgba[idx] = 0; rgba[idx + 1] = 0; rgba[idx + 2] = 0;
      continue;
    }
    // Scale each channel by the same luminance ratio so color is preserved.
    const scale = newG / oldG;
    for (let c = 0; c < 3; c++) {
      const v = (rgba[idx + c] * scale) | 0;
      rgba[idx + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return rgba;
}

/** Hamming distance between two 256-bit hashes. */
export function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < HASH_WORDS; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    // SWAR popcount
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    d += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return d;
}

/**
 * Find the K items in `index` closest to `queryHash`.
 * Returns [{ item, distance }, ...] sorted ascending by distance.
 */
export function findTopK(queryHash, index, K = 5) {
  if (!index?.length) return [];
  // Insertion-sorted heap, size K — much cheaper than full sort over 5k rows.
  const top = [];
  for (const row of index) {
    const d = hammingDistance(queryHash, row.hash);
    if (top.length < K) {
      top.push({ item: row.item, distance: d });
      top.sort((a, b) => a.distance - b.distance);
    } else if (d < top[K - 1].distance) {
      top[K - 1] = { item: row.item, distance: d };
      top.sort((a, b) => a.distance - b.distance);
    }
  }
  return top;
}

/**
 * Load the Tauri HTTP plugin's fetch when running in Tauri. Browser fetch
 * is blocked by CORS for assets.tarkov.dev (no Access-Control-Allow-Origin
 * header), which silently fails every icon download. The plugin's fetch
 * routes through Rust and bypasses browser CORS entirely. Falls back to
 * window.fetch in the hosted web build (where the origin check isn't
 * cross-origin the same way, and CORS fails are at least visible).
 */
async function resolveFetch() {
  if (!window.__TAURI_INTERNALS__) return window.fetch.bind(window);
  try {
    const mod = await import("@tauri-apps/plugin-http");
    return mod.fetch;
  } catch (_) {
    return window.fetch.bind(window);
  }
}

/**
 * Build the icon hash index from a list of items with gridImageLink.
 * Downloads each icon, hashes it, returns array of { item, hash }.
 * Calls onProgress(done, total) every batch.
 */
export async function buildIconIndex(items, { concurrency = 8, onProgress } = {}) {
  const withIcons = items.filter((i) => i.gridImageLink && i.id);
  const index = [];
  let done = 0;
  const fetchImpl = await resolveFetch();
  const workers = new Array(concurrency).fill(null).map(async () => {
    while (true) {
      const i = done++;
      if (i >= withIcons.length) return;
      const item = withIcons[i];
      try {
        const resp = await fetchImpl(item.gridImageLink);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const hash = dhash(bitmap);
        bitmap.close?.();
        index.push({ item: { id: item.id, name: item.name, shortName: item.shortName, width: item.width, height: item.height }, hash });
        if (onProgress && index.length % 50 === 0) onProgress(index.length, withIcons.length);
      } catch (_) { /* skip failed icon */ }
    }
  });
  await Promise.all(workers);
  onProgress?.(index.length, withIcons.length);
  return index;
}

/**
 * Serialize the hash index to a compact binary format for localStorage.
 * Layout: [count:u32][itemJson:length-prefixed utf8][hash:8 u32 LE] × count
 * For 5k items this is ~400KB — localStorage can hold it.
 */
export function serializeIndex(index) {
  const parts = [];
  const headers = [];
  let total = 4;
  for (const row of index) {
    const json = JSON.stringify(row.item);
    const utf8 = new TextEncoder().encode(json);
    headers.push(utf8);
    total += 4 + utf8.length + HASH_WORDS * 4;
  }
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  view.setUint32(0, index.length, true);
  let off = 4;
  for (let i = 0; i < index.length; i++) {
    view.setUint32(off, headers[i].length, true); off += 4;
    u8.set(headers[i], off); off += headers[i].length;
    for (let j = 0; j < HASH_WORDS; j++) { view.setUint32(off, index[i].hash[j], true); off += 4; }
  }
  return buf;
}

export function deserializeIndex(buffer) {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const count = view.getUint32(0, true);
  const out = [];
  let off = 4;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(off, true); off += 4;
    const item = JSON.parse(dec.decode(u8.subarray(off, off + len))); off += len;
    const hash = new Uint32Array(HASH_WORDS);
    for (let j = 0; j < HASH_WORDS; j++) { hash[j] = view.getUint32(off, true); off += 4; }
    out.push({ item, hash });
  }
  return out;
}

export const ICON_HASH_BITS = HASH_BITS;
