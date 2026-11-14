# Archimap

Interactive map of Dofus Retro underground zones, built from gameplay videos, for archimonster hunting. See [Plan.md](Plan.md) for the full plan.

## Setup

```sh
brew install uv ffmpeg tesseract
cd pipeline && uv sync
```

## Phase 1: video → map data

Run from `pipeline/` (outputs go to `../web/public/data/` and `../out/`):

```sh
# 1. Save one frame with a pixel grid to find where the [x,y] coordinates are shown
uv run python -m archimap.extract ../samples/clip.mp4 --preview 5

# 2. Check the boxes on the preview (red = coords box, green = view box)
uv run python -m archimap.extract ../samples/clip.mp4 --preview 5 \
    --coords-box 20,40,160,30 --view-box 0,0,1280,860

# 3. Run the pipeline
uv run python -m archimap.extract ../samples/clip.mp4 --zone my-zone --name "My zone" \
    --coords-box 20,40,160,30 --view-box 0,0,1280,860
```

Then open `out/my-zone/report.html` to review the detected maps. Maps with an orange border were placed by inference rather than OCR, so check those first.

Useful options:

| Option | Purpose |
| --- | --- |
| `--coords-box X,Y,W,H` | Area showing the map coordinates. Without it, OCR is skipped. |
| `--view-box X,Y,W,H` | Game area to keep in tiles. Also improves transition detection by ignoring the chat/UI. |
| `--start X,Y` | Coordinates of the first map, if OCR can't read it. |
| `--fps N` | Sampling rate (default 6). |
| `--dark-mean`, `--uniform-std` | Loading-frame thresholds, if map changes are missed or over-detected. |
| `--cut-diff N` | Also split on big frame jumps without a loading frame (off by default). |

Tests: `cd pipeline && uv run pytest`
