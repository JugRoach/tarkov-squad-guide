# Tarkov PvE Squad Guide — Claude Code Context

## Project Overview

A mobile-first progressive web app (PWA) built as a React single-file component. This is a tactical reference tool for Escape from Tarkov PvE players. It is currently built and iterated entirely as a Claude.ai artifact (React JSX), and this handoff is to continue development in Claude Code.

**Current version: v6**
**Source file:** `TarkovGuide.jsx` (single file, all components inline)

---

## What This App Does

A "one stop shop" field reference for Tarkov PvE that a player should be able to pull up in the time it takes for a map to load in-game. Key features:

1. **My Profile tab** — Each player sets their own name, color, and task list independently. No squad secretary. Tasks are sourced live from the tarkov.dev GraphQL API.

2. **Squad tab** — Before a raid, each player copies their share code (`TG2:...` base64 string) and pastes it in Discord. Teammates import it. The app combines all imported profiles to generate a single optimized squad route.

3. **Extract Selection** — After selecting a map and active players, each player picks their intended extract. Special extracts (keys, Paracord+Red Rebel, armored train, roubles) trigger an item-check prompt asking if the player has the required items. The chosen extract becomes the **forced final waypoint** in the route.

4. **Route Generation** — Nearest-neighbor optimization from spawn point through all players' priority task objectives, then appends extract as last stop. Rendered on the real tarkov.dev SVG map image with numbered gold waypoints and a green ⬆ extract marker.

5. **Extracts tab** — Quick reference for all PMC/Scav extracts per map, filtered by type (open/key/pay/coop/special/timed). Co-op extracts are grayed/struck-through since this is PvE only.

6. **Maps tab** — Quick-launch links to tarkov.dev, Mapgenie, and the Tarkov wiki for every map. Also contains PWA install instructions for iPhone/Android/Desktop.

7. **Post-Raid Tracker** — After a raid, each player logs their own progress (kills completed, items found). Updates their profile's progress object, which is included in their next share code.

8. **Persistent Storage** — Uses `window.storage` (Claude artifact built-in key-value store). On export to a real PWA/website, swap for `localStorage` or a backend.

---

## Architecture Decisions (Don't Re-Litigate These)

- **Single JSX file** — All components are in one file by design. This was intentional for the artifact environment. When building out, it's fine to split into components.
- **No backend** — Deliberately chosen. Cross-device sync is handled by share codes (base64 encoded profile). If a backend is added later, Supabase was discussed as the preference.
- **PvE only** — Co-op extracts are permanently disabled/grayed. No PvP considerations.
- **tarkov.dev API** — Live GraphQL API at `https://api.tarkov.dev/graphql`. Used for both task data and SVG map images. This is the canonical data source — do not hardcode task data.
- **Max squad size: 5** — Confirmed from official Tarkov wiki. Hard-coded as `MAX_SQUAD = 5`.
- **Share code format** — `TG2:` prefix + base64(JSON). JSON payload: `{v:2, n:name, c:color, t:tasks[], pr:progress{}}`. Don't change this without a migration path.
- **Route algorithm** — Nearest-neighbor from spawn origin `{x:0.5, y:0.85}` through objective waypoints, with extract appended last (not included in NN optimization).

---

## Data Sources

### tarkov.dev GraphQL API
- Endpoint: `https://api.tarkov.dev/graphql`
- Used for: map SVG images, coordinate spaces, all task/objective data
- Map images: `map.svg.url` — these are SVG files hosted on tarkov.dev CDN
- Task objective positions: world-space coordinates transformed to 0-1 normalized via `worldToPct(pos, bounds)` using `coordinateSpace {bottom, left, top, right}`
- **Important**: Not all objectives have coordinate data. Kill objectives (`type: "shoot"`) and item-find objectives rarely have positions. Location/mark/questItem objectives usually do.

### Hardcoded Data (EMAPS array)
The `EMAPS` array in the source contains hardcoded extract data for all 9 maps because the tarkov.dev API does not expose extract positions. Each extract has:
- `name`, `type` (open/key/pay/coop/special/timed), `note` (description)
- `pct: {x, y}` — approximate normalized position on the map SVG (0-1 scale). These are best-effort approximations, not exact.
- `requireItems: string[]` — items shown in the item-check prompt

---

## Current State of Each Feature

| Feature | Status | Notes |
|---|---|---|
| My Profile (name, color, tasks) | ✅ Complete | |
| Task browser (live from tarkov.dev) | ✅ Complete | Filters by trader and map |
| Share codes | ✅ Complete | TG2: format |
| Squad import | ✅ Complete | |
| Map selection (tarkov.dev API) | ✅ Complete | 9 maps |
| Faction toggle (PMC/Scav) | ✅ Complete | |
| Priority task selection per player | ✅ Complete | |
| Extract selection | ✅ Complete | All 9 maps, item checks |
| Route generation | ✅ Complete | NN algorithm, extract as final waypoint |
| Map overlay with route | ✅ Complete | SVG overlay on tarkov.dev map image |
| Conflict resolution (overlapping kill objectives) | ✅ Complete | Merge or separate |
| Post-raid progress tracker | ✅ Complete | |
| Persistent storage | ✅ Complete | window.storage (swap to localStorage for PWA) |
| PWA install instructions | ✅ Complete | iPhone/Android/Desktop |
| Roadmap progression guide | ✅ Complete | Extracts tab → roadmap sub-view |
| Extracts reference | ✅ Complete | All maps, PMC + Scav |

---

## Known Limitations / Next Steps

1. **Extract positions are approximate** — The `pct` values in EMAPS were manually estimated. A future improvement would be to cross-reference exact positions from community data (e.g., tarkov.dev's own extract markers if they expose them via API).

2. **window.storage → localStorage** — When deploying as a real PWA outside the Claude artifact environment, replace all `window.storage.get/set` calls with `localStorage.getItem/setItem`. The key names can stay the same.

3. **Quest tracker (early game Prapor/Therapist)** — In earlier versions there was a separate Quests tab with hardcoded early-game quest guides (Debut, Shootout Picnic, Delivery from the Past, etc.). This was removed in favor of the live tarkov.dev task browser. If re-adding, the quest detail view should include: objectives checklist, field notes, Mapgenie hint, reward info, and links to Mapgenie + wiki.

4. **More traders** — Currently all traders are browsable but only tasks for the current map are shown in the priority task selector. Could expand to show all active tasks across all maps.

5. **Route planner for non-API-positioned tasks** — Kill objectives don't have coordinates from the API. A future enhancement would be hardcoded "zone" positions for common kill objective areas (e.g., "Kill Scavs on Customs" → gas station / dorms / construction zones as selectable locations).

6. **Supabase backend** — If real-time sync is desired later, Supabase free tier was the agreed-upon choice. Would add: user accounts (or anonymous device IDs), cloud-synced profiles, squad rooms with live join codes. Share codes would still exist as fallback.

7. **React Native / Electron** — The PWA approach was chosen for immediate cross-platform availability. If a native app is wanted later, the component logic ports cleanly to React Native. Electron was also discussed for desktop.

---

## Player Colors

```js
const PLAYER_COLORS = ["#c8a84b","#5a9aba","#9a5aba","#5aba8a","#ba7a5a"];
```
Player 1 (you) defaults to gold. Imported players cycle through the rest.

---

## Tech Stack

- React (hooks only — useState, useEffect, useCallback)
- No external libraries (no Tailwind, no UI kit, no routing)
- Inline styles throughout (intentional for single-file portability)
- Fonts: `'Courier New', Consolas, monospace` — military terminal aesthetic
- Color theme: dark background `#07090b`, surface `#0d1117`, gold accent `#c8a84b`

---

## PWA Deployment

To deploy as a real installable PWA:

1. Create a Vite or CRA project
2. Drop `TarkovGuide.jsx` into `src/`
3. Replace `window.storage` calls with `localStorage`
4. Add `manifest.json` with app name, icons, `display: "standalone"`
5. Add a service worker (Vite PWA plugin handles this automatically)
6. Host on Vercel, Netlify, or GitHub Pages

The app is fully self-contained — no env vars, no API keys, no auth.

---

## Conversation History Summary

This project was built iteratively across a long Claude.ai conversation:
- Started as a map progression roadmap + extract viewer
- Added PvE framing (co-op extracts disabled, boss info)
- Added quest tracker with hardcoded early-game quests
- Rebuilt with live tarkov.dev API for real map images and task data
- Added 5-player squad system with per-player profiles
- Added share codes for squad coordination without a backend
- Added extract selection with item-check prompts
- Extract integrated as forced final route waypoint
- PWA install instructions added for all platforms

The user (Matt) is an Air Force training manager and active gamer. He plays Tarkov PvE with a group of friends. He is technically capable and uses Claude Code regularly. He prefers concrete, working implementations over abstract explanations.
