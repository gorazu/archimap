# Archimap

Interactive map of Dofus Retro zones (sewers, underground passages, labyrinth forests) for archimonster hunting: tick off every map of a zone as you visit it, by hand or automatically from a live capture of the game. See [Plan.md](Plan.md) for the full plan and the project's history.

Zones are built from the **Dofus Retro client's own files**: the list of maps of each sub-area with their coordinates, and each map's layout (floor, walls and the suns that lead to the next map). A gameplay recording can be added on top, to confirm passages or to cover maps the client can't read.

Current zones: Égouts de Bonta, Égouts de Brâkmar, Forêt maléfique, Sanctuaire des Dragoeufs, Sous-terrain des Dragoeufs, and Souterrains d'Astrub (Souterrain d'Astrub, Souterrain profond d'Astrub and Souterrain du Château d'Amakna, checked as one zone).

## Setup

```sh
brew install uv ffmpeg tesseract oven-sh/bun/bun
cd pipeline && uv sync
cd ../web && bun install
```

`ffmpeg` and `tesseract` are only needed for gameplay recordings.

## Adding a zone from the game client

Needs the Dofus Retro client installed and started at least once **in French** (the game caches its data on first launch; live mode matches the French sub-area names shown in game). Run from `pipeline/`:

```sh
uv run python -m archimap.client_zones list Egout   # find a sub-area's id
```

Each zone is a file `zones/<zone>.json`, its name being the zone's slug:

```json
{ "client_subarea": 75, "name": "Égouts de Brâkmar", "add_links": [], "remove_links": [] }
```

```sh
uv run python -m archimap.client_zones import       # (re)build every zone in zones/
```

This writes `web/public/data/<zone>/zone.json` and adds the zone to `web/public/data/zones.json`. The game files are found automatically on macOS and Windows; `--client-data`, `--client-maps` and `--language` point elsewhere.

What comes from the client:

- **Maps:** every map of the sub-area, by coordinates. Sub-areas where many maps share the same coordinates (Souterrain d'Amakna, Grotte Hesque, Village des Dragoeufs…) can't be used: Archimap tells maps apart by their coordinates, and the plan would show far fewer tiles than the zone has maps.
- **Passages:** from the **suns** in each map's file. A sun on a map's edge is a passage to the neighbouring map on that side, when that map has an exit back; ladders and doors inside closed rooms count too. On Égouts de Bonta, this finds every passage walked in a recording.
- **Layouts and paths:** each map's floor, walls and suns, and the walking routes between its suns. Some maps are split into separate parts, each with its own suns (the Forêt maléfique is a labyrinth); each part and each path is drawn separately.

Limits: only the unencrypted map files the client ships can be read. They are older versions of the maps (2005): exits match today's game, but decoration may differ. About 16% of maps have no such file (all of Caverne des Fungus, for example); those are joined to all their neighbours instead, which is why Caverne des Fungus isn't included.

### Zones made of several sub-areas

Sub-areas that lead into each other are better checked as one zone. List them as `parts` instead of `client_subarea`:

```json
{
  "name": "Souterrains d'Astrub",
  "parts": [
    { "client_subarea": 99, "part": "souterrain-astrub", "name": "Souterrain d'Astrub" },
    { "client_subarea": 100, "part": "souterrain-profond-astrub", "name": "Souterrain profond d'Astrub" },
    { "client_subarea": 181, "part": "souterrain-chateau-amakna", "name": "Souterrain du Château d'Amakna" }
  ]
}
```

Each map keeps its game sub-area. In the web map the zone is listed with its parts below it (`#souterrains-astrub/souterrain-profond-astrub`), and every part shares the zone's progress. In live mode, the location line matches any of the parts.

### Fixing passages

Add missing passages or remove wrong ones in the zone's file, as `[x1, y1, x2, y2]` pairs of neighbouring maps:

```json
{
  "client_subarea": 73,
  "name": "Égouts de Bonta",
  "add_links": [[-33, -58, -32, -58]],
  "remove_links": []
}
```

They are applied on every import. To apply them right away to an existing zone, run `uv run python -m archimap.corrections <zone>`.

A sun can lead to a map that isn't its neighbour on that side (in Souterrain d'Astrub, the left sun of [6,-19] leads to [5,-20]). Add such passages with `"add_passages": [{"a": [6, -19, "left"], "b": [5, -20, "right"]}]`: each end is a map and the side of its sun, or just the map when there is no sun to come back by.

**Entrances**, where suggested walks start, are found in the map files: ladders and doors leading out of the zone, and suns facing a map outside it. Remove a wrong one with `"remove_entrances": [[x, y]]`, or add one the files can't show (an NPC, for example) with `"entrances": [{"x": -3, "y": 14, "label": "PNJ"}]` (`"area"` picks the part of a split map, 0 by default).

## Adding a gameplay recording (optional)

A recording of the character walking through a zone gives the passages actually walked, and covers maps whose files the client can't read. Record the whole Dofus window (any size) with the **modern UI** option enabled and the **chat on the right side** of the window. Run from `pipeline/`:

```sh
uv run python -m archimap.extract ../samples/clip.mkv --zone my-zone --name "My zone"
```

The game area and the coordinates are found automatically; the run prints the boxes it used, and `--preview 5` draws them on the frame at 5 s. Coordinates are read with OCR and checked against the route (consecutive maps must be neighbours). Then open `out/my-zone/report.html` to review the detected maps.

If the zone also has a `zones/<zone>.json` with a `client_subarea`, the recorded maps and walked passages are kept and the client data adds the maps the recording missed, the layouts and the sun passages. Égouts de Bonta was built this way.

| Option | Purpose |
| --- | --- |
| `--coords-box X,Y,W,H` | Area showing the coordinate numbers (default: found from the "Coordonnées" label). |
| `--view-box X,Y,W,H` | Game area (default: detected from the chat panel and UI bar borders). |
| `--start X,Y` | Coordinates of the first map, if OCR can't read it. |
| `--fps N` | Sampling rate (default 10). |
| `--dark-mean`, `--uniform-std`, `--dip-ratio` | Loading-frame thresholds, if map changes are missed or over-detected. |
| `--text-threshold N` | Read the coordinates with one fixed brightness threshold (0-255). |
| `--cut-diff N` | Also split on big frame jumps without a loading frame (off by default). |

Videos stay out of git (`samples/` is ignored).

## Web map

```sh
cd web
bun run dev        # http://localhost:5173
bun run build      # static site in web/dist/
bun run test       # unit tests
```

The map is a plan with one tile per map, showing the map's layout: floor, walls, suns in yellow, and on split maps each part with an exit in its own colour. Solid lines are walking routes between a map's suns, dashed lines are map changes; the **Chemins** button shows or hides them.

The **Parcours** button draws a short walk through the whole zone, starting at an entrance (▶), with maps numbered in visiting order and the number of moves and of returns to a map already seen. It goes from sun to sun and takes split maps into account (each part has to be reached through its own suns). A walk is planned from each entrance of the zone; the panel lists them, the shortest first, and the one you pick is remembered. The walk is computed once and doesn't change as you check maps: the stretch already done is dimmed and checked maps' numbers are greyed. Maps that can't be reached from inside the zone (Sous-terrain des Dragoeufs, where you have to go back up to the surface) are counted apart and left out of the walk.

Click or tap a map to mark it checked. Hover (desktop) or tap (mobile) shows its coordinates. Progress is saved in the browser per zone, and **Nouvelle chasse** clears it. The selected zone is kept in the URL (`#zone-slug`), so you can link to it.

To try the app without game data, `uv run python -m archimap.mock` (from `pipeline/`) writes three mock zones, and `--clean` removes them.

## Live capture

In desktop Chrome or Edge, open a zone and click **Direct**, then **Démarrer la capture** and share the Dofus Retro window (any window size). Before starting, enable the **modern UI** option and place the **chat on the right side** of the window: the game area is found from the chat panel and UI bar borders. Archimap reads the coordinates about twice per second and checks each map you walk onto. The current map is outlined in blue and kept in view.

- Live mode also reads the game's location line ("Bonta (**Egout de Bonta**) - Bontarien"). The sub-area in parentheses tells which zone you're in, so walking from one zone into another switches the map automatically (**Changer de zone automatiquement**, on by default). It also keeps maps from being checked while you walk on the surface above an underground zone, which has the same coordinates. When the line can't be read, the coordinates decide.
- Live mode guides you along the chosen walk: the panel says which sun to click next ("soleil en bas à droite → [-26,-57]"), and that sun pulses on the map. If you leave the walk, it shows the shortest way back to the next map to check ("Retour au parcours : …") without changing the walk.
- A position is confirmed after a few identical readings in a row (the **Stabilité** setting). A jump to a map that isn't next to the current one (teleport) needs twice as many.
- The panel shows what OCR reads and the crop it reads from, which helps when something looks off. **Recalibrer** finds the layout again, for example after changing the interface.
- Nothing is uploaded. Tesseract.js downloads its OCR engine and English data from a CDN the first time.

## Deployment

The site is deployed on Vercel from GitHub: the Vercel project imports `gorazu/archimap` with **Root Directory** set to `web`, and `web/vercel.json` sets the Bun install, the Vite build and the `dist` output. Every push to `main` redeploys; commit the zone files (`zones/`) and the generated data (`web/public/data/`) to publish a zone.

Tests: `cd pipeline && uv run pytest`, and `cd web && bun run test`.
