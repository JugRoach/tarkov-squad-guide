// One-shot SVG → 1024×1024 PNG for the Tauri icon pipeline.
// Usage: node scripts/rasterize-icon.mjs
// Then:  npm run tauri icon src-tauri/icons/source.png
// (regenerates every platform icon from the single source PNG).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '..', 'public', 'icon-512.svg');
const outDir = resolve(here, '..', 'src-tauri', 'icons');
const outPath = resolve(outDir, 'source.png');

mkdirSync(outDir, { recursive: true });
const svg = readFileSync(svgPath);
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } });
writeFileSync(outPath, resvg.render().asPng());
console.log(`Wrote ${outPath}`);
