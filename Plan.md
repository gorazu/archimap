# [AGENTS.md](http://AGENTS.md) — Archimap

## Goal

Archimap is an interactive web map of **Dofus Retro underground zones** (subterrains, caves, dungeons). It helps a player check every map of a zone when hunting **archimonsters**.

The map is built from a **gameplay video** of the character walking through a zone. Later, it updates **live** from a screen share of the game, so maps are checked automatically as the player visits them.

## Phases (build in order)

### Phase 1: Video → map data (offline, Python)

Input: a screen recording (mp4/mkv/webm) of the character exploring a zone.

1. **Extract frames** with FFmpeg (sample ~4–10 fps).
2. **Find map changes** with OpenCV. Dofus Retro shows a short loading transition between maps (dark or near-uniform frames, then a big frame-difference jump). Group the frames between two transitions as one map, and keep the sharpest frame (highest Laplacian variance) that is free of UI popups or fights.
3. **Read coordinates** with Tesseract (`pytesseract`). Crop the UI area that shows the `[x,y]` map coordinates, then preprocess it (upscale, threshold, whitelist `-0123456789,[]`). The crop region must be configurable, because the user's resolution and UI layout are unknown. Verify it on the first real video.
4. **Fallback when OCR fails:** infer the position from the previous map plus the exit direction (the side of the screen the character left from), and flag it as `"source": "inferred"` for manual review.
5. **Deduplicate** maps that were visited several times (same coordinates → keep the best frame).
6. **Export:**
   - `web/public/data/<zone-slug>/zone.json`: see the schema below

The pipeline must be a CLI, for example: `python -m archimap.extract video.mp4 --zone "zone-slug" [--coords-box x,y,w,h] [--fps 6]` It should also write a debug report (an HTML or contact sheet of the detected maps and the OCR'd coordinates) so results can be reviewed quickly.

### Phase 2: Web map (React app, static build)

- **React** (TypeScript, built with **Vite**) plus **Leaflet** via `react-leaflet` (`L.CRS.Simple`), with map tiles placed on a grid by in-game coordinates (`y` grows downward as in game). The build output (`web/dist/`) is a static site that can be hosted anywhere.
- Tap or click a map to toggle **checked**. Show coordinates on hover or tap.
- Progress counter ("23 / 61 checked") and a **New hunt** button that resets checks for the zone.
- A zone selector when there are several zones.
- Persistence: **localStorage**, keyed per zone. Keep storage behind a small `progressStore` interface (`get / set / reset / subscribe`) so a shared backend can replace it later. Components read it through a `useProgress(zone)` hook (built on `useSyncExternalStore`), never touching localStorage directly.
- Must work on desktop and mobile.

### Phase 3: Live mode (in the browser, desktop Chrome/Edge)

- The **Screen Capture API** (`getDisplayMedia`) captures the Dofus window, chosen by the user.
- A few times per second, crop the coordinates area and read it with **Tesseract.js**. On a stable reading (same value for N frames), mark that map **checked** and highlight it as the **current position**.
- Settings panel: coordinates crop box (with a visual picker on the captured frame), confidence threshold, pause/resume.
- Everything runs locally in the browser. No video is uploaded anywhere.

### Phase 4 (future): Group sharing

- Several players hunt the same zone, and their checks merge in real time.
- Replace `progressStore` with a backend (for example Supabase, Firebase or a small WebSocket server). Room or link based, no accounts at first.
- Don't build this yet. Just keep phase 2/3 compatible with it.

## `zone.json` schema

```json
{
  "zone": "zone-slug",
  "name": "Human-readable zone name",
  "source_video": "file name" | null,
  "tile_size": [w, h],
  "maps": [
    {
      "x": -5, "y": 12,
      "source": "ocr" | "inferred" | "manual" | "client",
      "confidence": 0.0,
      "video_time": 12.4
    }
  ],
  "links": [[x1, y1, x2, y2]],
  "client_subarea": 73
}

```

## Repo layout (target)

```
archimap/
  AGENTS.md
  README.md
  pipeline/            # Python package: archimap.extract etc.
    archimap/
    tests/
    pyproject.toml
  web/                 # React + Vite app
    index.html
    package.json
    bun.lock
    vite.config.ts
    src/               # components, hooks, progressStore
    public/data/<zone-slug>/
  samples/             # small test clips (git-ignored if large)

```

## Tech stack

- **Pipeline:** Python 3.11+, FFmpeg, OpenCV, Tesseract + pytesseract, Pillow, NumPy. Manage dependencies with `pyproject.toml`.
- **Web:** React + TypeScript, Vite (dev server and build), Leaflet with `react-leaflet`, Tesseract.js (phase 3, OCR engine and English data loaded from its CDN). Use **Bun** as the runtime and package manager (`bun install`, `bun run dev`, `bun run build`); no Node.js or npm.
- **Tests:** pytest for the pipeline (transition detection, OCR parsing, coordinate inference); run the web manually or with Playwright later.

## Conventions

- Keep large media (videos, raw frames) out of git. Add them to `.gitignore`; commit only the generated tiles and JSON.
- Every pipeline stage is a separate, testable function. Debug outputs go to `out/` (git-ignored).
- Coordinates are always integers `(x, y)`, matching the in-game display.
- The user is French and plays Dofus Retro. UI text can be in French, and code and comments in English.

## Open questions to settle with the user

- Screen resolution, and whether the `[x,y]` coordinates are visible in their recordings.
- Which zone the first video covers.
- Whether to keep the game view's UI (bottom bar) in tiles or crop to the map area only.

## Status

- Phase 1 pipeline built (`pipeline/archimap/`), tested on synthetic clips (`uv run pytest`, 32 tests).
  - Extra CLI options beyond the plan: `--view-box` (crop tiles to the game area), `--start x,y` (anchor the first map when OCR fails), `--preview SECONDS` (save a frame with a pixel grid to choose the boxes).
  - Map changes are detected from loading frames only. Splitting on hard cuts is off by default (`--cut-diff`), because big popups would split a visit. If the frames before and after a loading screen show the same map (fights, flashes), they stay one visit.
- Phase 2 web map built (`web/`): React + TypeScript + Vite + react-leaflet, run with Bun. Checked on desktop and on a phone-sized viewport with demo data.
  - The pipeline also writes `web/public/data/zones.json` (`{"zones": [{"zone", "name", "maps"}]}`), because a static site can't list folders.
  - Progress goes through `progressStore` (localStorage, synced across tabs) and the `useProgress` hook. The store is provided through React context (`ProgressStoreContext`), so phase 4 only swaps the provider.
  - Map tiles with `"source": "inferred"` get a dashed orange border and a "Position estimée" tooltip.
  - Double-tap/double-click zoom is off, so quick taps on neighbouring maps don't zoom in.
- Real clips of the Égouts de Bonta, all maps read by OCR and every step of the route moves exactly one map:
  - `samples/egouts-de-bonta.mkv` (cropped to the game area): 29 visits → 25 maps, `--coords-box 245,80,180,40`.
  - `samples/egouts-de-bonta-window.mkv` (full Dofus window, 1920x1080) is now the standard recording setup: 37 visits → 32 maps with `--coords-box 175,58,150,34 --view-box 0,0,1371,837`. Live mode (phase 3) can reuse these boxes.
  - OCR keeps near-white text pixels (`--text-threshold`, default 185), thickens the strokes, and falls back to Otsu; Otsu alone failed on light walls. Confidence is the share of sampled frames that agree, because Tesseract reports 0 for correct text when the character set is restricted.
  - Loading fades can be very short (~0.15 s fully dark), so a frame much darker than the visit's recent brightness also counts as loading (`--dip-ratio 0.6`), and the default sampling rate is now 10 fps.
- Any capture size (requires the **modern UI** option in Dofus Retro, which scales the interface evenly, and the chat on the right side of the window). `archimap/layout.py`:
  - The game area is found from the chat panel and UI bar borders, using the median edge strength over frames of different maps.
  - The coordinates box is sized from the "Coordonnées" label found by OCR in the top-left corner of the game area. If the label isn't found, a default position relative to the game area is used.
  - OCR crops are resized to a fixed height (`OCR_HEIGHT`). Each crop is read with two binarizations (fixed threshold 160, and 0.7 × the crop's brightest text with thickened strokes), because each one fails at different sizes. When a map's vote is uncertain (< 75%), `resolve_with_route` picks the candidate next to the neighbouring maps.
  - Verified with no boxes given on the full-window clip (37/37 visits right) and on copies resized to 960x540, 1280x720, 1920x1080 and 2560x1440 (12/12 each, after the route check at 540p and 720p).
  - Phase 3 must port the same steps to the browser: game-area borders, label search, size normalization, two binarizations with voting, and the adjacency check (the current position must be next to the previous one).
- Phase 3 live capture built (`web/src/live/`): `getDisplayMedia` window capture, layout detection ported from the pipeline (game-area borders over distinct frames, "Coordonnées" label search with Tesseract.js, size-normalized bicubic resize, two binarizations), about 2 reads per second, and `PositionTracker` (3 identical reads to confirm a move to an adjacent map, twice that for a non-adjacent jump). When the two readings disagree, it prefers the one adjacent to the current map, then one that is a map of the zone.
  - Verified end to end by feeding the recorded clip as the capture stream (Playwright): 12/12 maps of the first 50 s checked in route order at 960x540, 1280x720, 1920x1080 and 2560x1440, with no false positives.
  - Not built yet: the manual box picker. OCR plus automatic detection covers the tested setups.
- Pipeline speed: about 80 s for a 10-minute 1080p video (was ~14 min). Starting a Tesseract process per crop dominated, so OCR now runs after decoding in a few large batches (`read_coords_many`: list file, one process per batch, batches in parallel), and layout detection reads only keyframes.
- Zones from the game client (`archimap.client_zones`): the Dofus Retro client caches its map data as Flash shared objects (`ANKXTRASO_*_MA.sol`: map → x, y, sub-area; sub-area and area names), read with `archimap/sol.py`. `zones/<zone>.json` sets the sub-area, display name and passage corrections. Checked against the recording: all 80 recorded Égouts de Bonta maps are in sub-area 73, which adds 2 maps the recording missed. Imported so far: Égouts de Bonta and Brâkmar, Caverne des Fungus, Souterrain du Château d'Amakna, Souterrain d'Astrub, Souterrain profond d'Astrub. Left out because many maps share coordinates: Souterrain (Amakna) 73 maps on 12 cells, Souterrain mystérieux 19 on 7, Grotte Hesque 10 on 1. The client data has no passages (map files are encrypted), so client maps are joined to all their neighbours.
- Plan view (default): the web app draws each map as a schematic tile (room, corridors, coordinates) instead of the screenshot, so tooltips and overlays in the captures no longer matter. Corridors come from `links` in `zone.json`, which are the passages the player walked (consecutive adjacent visits); data without `links` falls back to joining neighbouring maps. A median-of-frames tile composite was tried (it removed tooltips well) but was dropped in favour of the plan. Screenshots (`tiles/`, `thumbs/`) and the Photos view were then removed entirely: the plan is the only view, and zone data is just `zone.json`.
