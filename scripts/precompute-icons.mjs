// Precompute the dHash icon index so the scanner has it instantly on first
// launch instead of spending ~60s downloading ~4800 icons. The runtime hash
// path lives in src/lib/iconHash.js and uses the browser's canvas; @napi-rs/
// canvas is a Skia-based drop-in that matches that pipeline closely enough
// for the resulting hashes to align with runtime captures.
//
// Output: src/data/icon-index-v1.bin (same binary format as the browser's
// serializeIndex, so useIconIndex can deserialize it with no bespoke loader).
//
// Run: npm run precompute-icons
// Regenerate after: item list additions from tarkov.dev (~periodically),
// any change to the hash algorithm, or on each release cycle as part of
// the release checklist.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const API_URL = "https://api.tarkov.dev/graphql";
const HASH_W = 17;
const HASH_H = 16;
const HASH_WORDS = 8;
const CONCURRENCY = 12;

const ITEM_LIST_Q = `{items(gameMode:pve){id name shortName width height gridImageLink}}`;

async function fetchItems() {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: ITEM_LIST_Q }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data?.items || [];
}

// Must mirror src/lib/iconHash.js exactly — browser canvas + this Skia
// pipeline return different pixels otherwise, which would inflate hamming
// distances between precomputed hashes and runtime captures.
function hashFromRgba(rgba) {
  const gray = new Uint8Array(HASH_W * HASH_H);
  for (let i = 0; i < gray.length; i++) {
    const idx = i * 4;
    gray[i] = ((rgba[idx] * 299 + rgba[idx + 1] * 587 + rgba[idx + 2] * 114) / 1000) | 0;
  }
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

async function hashIconAt(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const img = await loadImage(buf);
  const canvas = createCanvas(HASH_W, HASH_H);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, HASH_W, HASH_H);
  const { data } = ctx.getImageData(0, 0, HASH_W, HASH_H);
  return hashFromRgba(data);
}

// Binary layout must match deserializeIndex in src/lib/iconHash.js:
//   [count:u32 LE][itemLen:u32 LE][itemJson:utf8][hash:8 u32 LE] × count
function serializeIndex(index) {
  const encoder = new TextEncoder();
  const headers = index.map((row) => encoder.encode(JSON.stringify(row.item)));
  let total = 4;
  for (const h of headers) total += 4 + h.length + HASH_WORDS * 4;
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
  return Buffer.from(buf);
}

async function main() {
  const t0 = Date.now();
  console.log("[precompute-icons] fetching item list...");
  const items = await fetchItems();
  const withIcons = items.filter((i) => i.gridImageLink && i.id);
  console.log(`[precompute-icons] ${withIcons.length} items with icons (of ${items.length} total)`);

  const index = [];
  const failures = [];
  let completed = 0;
  let nextIdx = 0;

  const workers = new Array(CONCURRENCY).fill(null).map(async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= withIcons.length) return;
      const item = withIcons[i];
      try {
        const hash = await hashIconAt(item.gridImageLink);
        index.push({
          item: {
            id: item.id,
            name: item.name,
            shortName: item.shortName,
            width: item.width,
            height: item.height,
          },
          hash: Array.from(hash),
        });
      } catch (e) {
        failures.push({ id: item.id, name: item.name, reason: e.message });
      }
      completed++;
      if (completed % 100 === 0 || completed === withIcons.length) {
        process.stdout.write(`\r[precompute-icons] ${completed}/${withIcons.length}`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");

  if (failures.length) {
    console.warn(`[precompute-icons] ${failures.length} icons failed:`);
    for (const f of failures.slice(0, 10)) console.warn(`  - ${f.name} (${f.id}): ${f.reason}`);
    if (failures.length > 10) console.warn(`  ... and ${failures.length - 10} more`);
  }

  // Sort for deterministic output — dHash comparison is order-independent
  // but sorted output produces stable diffs when the file is checked in.
  index.sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputPath = resolve(__dirname, "..", "src", "data", "icon-index-v1.bin");
  await mkdir(dirname(outputPath), { recursive: true });
  const buf = serializeIndex(
    index.map((row) => ({ item: row.item, hash: new Uint32Array(row.hash) })),
  );
  await writeFile(outputPath, buf);

  const elapsed = Date.now() - t0;
  console.log(
    `[precompute-icons] wrote ${outputPath}  (${index.length} entries, ${buf.length} bytes, ${(elapsed / 1000).toFixed(1)}s)`,
  );
}

main().catch((e) => {
  console.error("[precompute-icons] failed:", e);
  process.exit(1);
});
