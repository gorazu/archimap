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
   - `web/public/data/<zone-slug>/tiles/<x>_<y>.webp`: the cropped game view, compressed
   - `web/public/data/<zone-slug>/zone.json`: see the schema below
   - `web/public/data/<zone-slug>/thumbs/`: small images used for live-mode matching (phase 3)

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
- Fallback: **image matching** of the downscaled frame against `thumbs/` (perceptual hash or small-image correlation), restricted to the current map's neighbours.
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
  "source_video": "file name",
  "tile_size": [w, h],
  "maps": [
    {
      "x": -5, "y": 12,
      "tile": "tiles/-5_12.webp",
      "thumb": "thumbs/-5_12.png",
      "source": "ocr" | "inferred" | "manual",
      "confidence": 0.0,
      "video_time": 12.4
    }
  ]
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
- **Web:** React + TypeScript, Vite (dev server and build), Leaflet with `react-leaflet`, Tesseract.js (phase 3). Use **Bun** as the runtime and package manager (`bun install`, `bun run dev`, `bun run build`); no Node.js or npm.
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
- Next step: run it on the user's first short clip (5–10 maps), find the coords box with `--preview`, and tune the thresholds.
