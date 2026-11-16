# Archimap

Interactive map of Dofus Retro underground zones, built from gameplay videos, for archimonster hunting. See [Plan.md](Plan.md) for the full plan.

## Setup

```sh
brew install uv ffmpeg tesseract oven-sh/bun/bun
cd pipeline && uv sync
cd ../web && bun install
```

## Phase 1: video → map data

Record the whole Dofus window (any size) with the **modern UI** option enabled and the **chat on the right side** of the window (the game area is found from the chat panel's border). Run from `pipeline/` (outputs go to `../web/public/data/` and `../out/`):

```sh
uv run python -m archimap.extract ../samples/clip.mkv --zone my-zone --name "My zone"
```

The game area (left of the chat panel, above the UI bar) and the coordinates (next to the "Coordonnées" label) are found automatically at any capture size; the run prints the boxes it used. To check them on one frame first (red = coordinates, green = game area):

```sh
uv run python -m archimap.extract ../samples/clip.mkv --preview 5
```

If detection goes wrong on an unusual setup, set the boxes by hand with `--coords-box` and `--view-box` (pixels, `x,y,w,h`).

Then open `out/my-zone/report.html` to review the detected maps. Maps with an orange border were placed by inference rather than OCR, so check those first.

Useful options:

| Option | Purpose |
| --- | --- |
| `--coords-box X,Y,W,H` | Area showing the coordinate numbers (default: found from the "Coordonnées" label). |
| `--view-box X,Y,W,H` | Game area to keep in tiles (default: detected from the chat panel and UI bar borders). |
| `--start X,Y` | Coordinates of the first map, if OCR can't read it. |
| `--fps N` | Sampling rate (default 10). |
| `--dark-mean`, `--uniform-std`, `--dip-ratio` | Loading-frame thresholds, if map changes are missed or over-detected. |
| `--text-threshold N` | Read the coordinates with one fixed brightness threshold (0-255) instead of the default pair tuned for any capture size. |
| `--cut-diff N` | Also split on big frame jumps without a loading frame (off by default). |

Tests: `cd pipeline && uv run pytest`

Each run also adds the zone to `web/public/data/zones.json`, which the web map reads to list the zones.

## Phase 2: web map

```sh
cd web
bun run dev        # http://localhost:5173
bun run build      # static site in web/dist/, host it anywhere
bun run test       # unit tests (progress store, tile geometry)
```

To try the map without a video, write three mock zones (and remove them later):

```sh
cd pipeline
uv run python -m archimap.mock          # mock-grotte, mock-souterrain, mock-donjon
uv run python -m archimap.mock --clean  # removes only the mock-* zones
```

The map opens as a **plan**: one drawn tile per map, with corridors for the passages walked in the recording (saved as `links` in `zone.json`). **Photos** switches to the captured screenshots.

Click or tap a map to mark it checked. Hover (desktop) or tap (mobile) shows its coordinates. Progress is saved in the browser per zone, and **Nouvelle chasse** clears it. The selected zone is kept in the URL (`#zone-slug`), so you can link to it.

### Fixing passages on the plan

Corridors on the plan are the passages walked in the recording (two maps visited one right after the other). Passages you didn't walk are missing, and two neighbouring maps aren't always connected. Fix them in `zones/<zone>.json`:

```json
{
  "add_links": [[-33, -58, -32, -58]],
  "remove_links": []
}
```

The pipeline applies this file on every run. To apply it right away without reprocessing the video, run `uv run python -m archimap.corrections <zone>` from `pipeline/`, then commit `zones/` and the zone data.

### Deployment

The site is deployed on Vercel from GitHub: the Vercel project imports `gorazu/archimap` with **Root Directory** set to `web`, and `web/vercel.json` sets the Bun install, the Vite build and the `dist` output. Every push to `main` redeploys; commit regenerated zone data in `web/public/data/` to publish it.

## Phase 3: live capture

In desktop Chrome or Edge, open a zone and click **Direct**, then **Démarrer la capture** and share the Dofus Retro window (any window size). Before starting, enable the **modern UI** option and place the **chat on the right side** of the window: the game area is found from the chat panel and UI bar borders. Archimap finds the game area and the coordinates by itself, reads them about twice per second, and checks each map you walk onto. The current map is outlined in blue and kept in view.

- A position is confirmed after a few identical readings in a row (the **Stabilité** setting). A jump to a map that isn't next to the current one (teleport) needs twice as many.
- The panel shows what OCR reads and the crop it reads from, which helps when something looks off. **Recalibrer** finds the layout again, for example after changing the interface.
- Frames stay in the browser. Tesseract.js downloads its OCR engine and English data from a CDN the first time.
