# Tarkov Planner — Claude Code Context

Tactical Escape from Tarkov PvE companion: task tracker, route planner,
build optimizer, in-game hover-scan, squad coordination. Desktop-first
(Tauri + WebView2), with a hosted web fallback that will be repurposed as
a marketing landing page.

**Repo root**: `tarkov-guide/` (directory name, pre-rename)
**Package name**: `tarkov-planner` (display name `Tarkov Planner`)
**Rust crate**: `tarkov-guide` / `tarkov_guide_lib` (internal, unchanged
to avoid touching the `.cargo/config.toml` target-dir path)
**Tauri bundle identifier**: `com.tarkovguide.desktop` — do NOT change, it
anchors the updater signing chain for existing installs.

---

## Architecture

Vite + React (hooks only, no external UI kit) with a Tauri (Rust) shell
for desktop. Same React build serves both the web PWA and the Tauri
webview; runtime branches on `window.__TAURI_INTERNALS__`.

### Top-level source layout (`src/`)
- `main.jsx` — entry, branches between `DesktopApp` (Tauri) and the web
  app. Also hosts the `scanner-popout` secondary-webview entrypoint.
- `DesktopApp.jsx` — primary Tauri window; tab routing, global search,
  updater banner, overlay toggle.
- `api.js` — tarkov.dev GraphQL client + query strings.
- `constants.js` — shared timings, codes, default scanner threshold.
- `theme.js` — design tokens (`T`), player colors, spacing scale.
- `supabase.js` — Supabase client for squad-room realtime.
- `tabs/` — one file per primary tab: Tasks, Raid, Builds, Intel, Profile.
- `components/` — reusable pieces (ScannerPopout, OverlayControls,
  MapOverlay, LogWatcherSection, PriceSearch, etc.).
- `hooks/` — `useStorage`, `useSquadRoom`, `useIconIndex`,
  `useScanAndFetch`, `useUpdater`, `useDebounce`, `useCopyToClipboard`.
- `lib/` — pure data helpers: `shareCodes`, `taskUtils`, `mapData`,
  `configData`, `buildOptimizer`, `buildStats`, `availability`,
  `fuzzyMatch`, `iconHash`, `tauri` (lazy loader).

### Rust side (`src-tauri/src/`)
- `lib.rs` — plugin registration, invoke handlers, global shortcuts
  (Alt+T/O/S/P), scanner-popout window management.
- `scanner.rs` — screen capture at cursor, Windows OCR, tooltip-region
  OCR, RGBA capture for dHash.
- `log_watcher.rs` — resolves Tarkov's `build/Logs` dir, parses
  `application_*.log` + `push-notifications_*.log` for raid and task
  events.

### Tauri plugins in use
`tauri-plugin-global-shortcut`, `tauri-plugin-updater`,
`tauri-plugin-process`. The `shell` and `dialog` plugins were removed as
unused. `tauri_plugin_process` is load-bearing — `useUpdater.js`
imports `relaunch` from it.

### Capabilities
See `src-tauri/capabilities/default.json`. Scoped to `main` and
`scanner-popout` windows. Only permissions actually exercised at runtime
are declared — don't add capabilities speculatively.

---

## Frontend data flow

- **tarkov.dev GraphQL** (`https://api.tarkov.dev/graphql`) is the
  canonical source for tasks, maps, items, traders, weapons, hideout.
  Do not hardcode this data — re-fetch on load, cache in state.
- **Map SVGs**: `map.svg.url` from tarkov.dev CDN.
- **Coordinates**: task objectives come in world-space. Convert with
  `worldToPct(pos, bounds)` using `coordinateSpace` from the API.
  Kill (`shoot`) and findItem objectives usually lack coordinates.
- **Extract positions**: hand-maintained in `lib/mapData.js` (`EMAPS`) —
  the API doesn't expose them.

### Local persistence
`localStorage` via `useStorage` hook. Key names are versioned
(e.g. `tg-myprofile-v3`, `tg-squad-v3`, `tg-builds-v1`). Do not reuse
an old key for a new shape.

### Share codes
`TG2:` prefix + base64(JSON) for profiles, `TGB:` for builds. Canonical
implementation: `src/lib/shareCodes.js`. Tests: `src/lib/utils.test.js`.

### Squad rooms (Supabase realtime)
`useSquadRoom` hook. Profiles live in `squad_members.profile` as a JSON
column with shape `{name, color, tasks, progress, pmcLevel,
traderLevels, ...}`. Post-raid tracker and the planned log watcher both
write into the same `progress` object.

---

## Desktop surface

### Scanner pipeline (`useScanAndFetch` + `scanner.rs`)
1. `scan_at_cursor` grabs a 220×130 region around the cursor and runs
   Windows Media OCR on it.
2. `capture_rgba_at_cursor` returns raw RGBA for the 80×80 tile under the
   cursor (used by dHash).
3. Frontend tone-maps the tile (HDR stretch via `iconHash.js`), computes
   a 256-bit difference hash, compares against all ~4800 tarkov.dev icon
   hashes from `useIconIndex`.
4. **Combined scoring** (OCR fuzzy score + dHash score, additive) picks
   the best item every frame.
5. Every ~4th scan, `ocr_tooltip_region` captures a larger 420×320
   region below cursor and verifies via token-bag-subset + shortName
   agreement filters.

### Secondary webview
`scanner-popout` is a separate Tauri webview (`?window=scanner-popout`
query param). Profile settings sync via `storage` events on
`tg-myprofile-v3`. See known quirks below.

### Global hotkeys
Registered in `lib.rs::run()`:
- **Alt+T** — toggle main window
- **Alt+O** — toggle overlay mode (emits `toggle-overlay` event)
- **Alt+S** — toggle auto-scan (fan-out to main + popout)
- **Alt+P** — toggle scanner popout

### Log watcher (`log_watcher.rs`)
One-shot parser (Phase A). Tails `build/Logs/<session>/*.log` files
looking for `application_*` (raid start/end, profile select, session
mode) and `push-notifications_*` (chat-message task
started/failed/finished via MessageType codes 10/11/12). Live watch via
the `notify` crate is the next phase.

### Auto-updater
GitHub Releases. Endpoint in `tauri.conf.json` points at `latest.json`
on the `JugRoach/tarkov-planner` repo. Release pipeline is
`.github/workflows/release.yml`, tag-triggered on `v*`.

---

## Scripts (`package.json`)
- `dev` — Vite dev server (web)
- `build` — Vite production build → `dist/`
- `preview` — Vite preview of built bundle
- `desktop` — `tauri dev` (runs Vite + Tauri together)
- `desktop:build` — `tauri build` (produces installer)
- `test` / `test:watch` — Vitest (ESLint v9 flat config)
- `lint` — `eslint src/`

---

## Release procedure

**Always bump version BEFORE tagging.** CI builds the installer from the
version numbers in the tree at the tagged commit, not from the tag name.

1. Bump version in all four places:
   - `package.json` (`version`)
   - `src-tauri/tauri.conf.json` (`version`)
   - `src-tauri/Cargo.toml` (`[package] version`)
   - `src-tauri/Cargo.lock` (run `cargo check` to refresh)
2. Commit: `release: v0.X.Y`
3. `git tag v0.X.Y && git push --tags`
4. CI in `.github/workflows/release.yml` produces `latest.json` + the
   MSI/NSIS installers + the updater `.sig` file.

---

## Known quirks

- **WebView2 cache** (`%LOCALAPPDATA%\com.tarkovguide.desktop\EBWebView`)
  can serve stale JS after a Tauri rebuild even though the dev URL
  reloads. Clear it if UI changes aren't showing up.
- **Vite HMR does not reach secondary webviews.** After editing JSX
  that's rendered in the scanner popout, close and reopen the popout
  (Alt+P twice) — the main window HMRs fine, the popout has to reload.
- **Tauri sync commands that create webviews deadlock.** Anything that
  calls `WebviewWindowBuilder::build()` must be `async` and dispatched
  with `app.run_on_main_thread(...)`. See `open_scanner_popout` for the
  pattern.
- **Windows HDR breaks pixel-value matching.** Screen captures come
  through with compressed dynamic range under Windows HDR on the
  Odyssey G9. `iconHash.js::toneMapRgba` does a 5–95 percentile luminance
  stretch before hashing. Don't skip this step.
- **`set_decorations(false)` breaks mouse events** on Windows. Frameless
  windows are off the table — use `decorations: true` always.
- **Scanner 80×80 tile crop is fixed-size.** Works on the Odyssey G9 at
  native Tarkov UI scale. Very different UI scales may need tuning.

---

## What NOT to touch
- Share-code format (`TG2:` / `TGB:`) — there's no migration path; it's
  in the wild.
- The Tauri bundle identifier (`com.tarkovguide.desktop`) — changing it
  invalidates the updater signing chain for existing installs.
- `tauri_plugin_process` — looks unused but `useUpdater.js` needs it.
- `EMAPS` extract positions — hand-tuned against each map SVG; don't
  auto-regenerate without a visual diff.
