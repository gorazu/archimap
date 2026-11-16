"""CLI: write mock zones so the web app can be tried without a video.

    python -m archimap.mock          # write the mock zones
    python -m archimap.mock --clean  # remove them again
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

from .export import export_zone, update_zone_index
from .extract import find_repo_root
from .models import MapVisit

# Only the shape matters: it gives the plan tiles their proportions.
TILE_SHAPE = (839, 1371, 3)
PREFIX = "mock-"


def _layout(rows: list[str], origin: tuple[int, int]) -> list[tuple[int, int, str]]:
    """Turn an ASCII layout into (x, y, source): '#' = OCR, '?' = inferred."""
    cells = []
    for dy, row in enumerate(rows):
        for dx, ch in enumerate(row):
            if ch in "#?":
                cells.append((origin[0] + dx, origin[1] + dy, "ocr" if ch == "#" else "inferred"))
    return cells


ZONES = {
    f"{PREFIX}grotte": ("Grotte (mock)", (-8, 10), [
        "..####...",
        ".##..##..",
        "##....#?#",
        "#..##.#..",
        "####..###",
        "..#....#.",
        "..######.",
    ]),
    f"{PREFIX}souterrain": ("Souterrain (mock)", (2, -4), [
        "#########",
        "#...#...#",
        "#.?.#.#.#",
        "#...#.#..",
        "###.###..",
    ]),
    f"{PREFIX}donjon": ("Donjon (mock)", (0, 0), [
        "##?##",
        "....#",
        "....#",
    ]),
}


def write_mock_zones(data_dir: Path) -> list[str]:
    written = []
    for slug, (name, origin, rows) in ZONES.items():
        cells = _layout(rows, origin)
        coords = {(cx, cy) for cx, cy, _ in cells}
        maps = []
        for i, (cx, cy, source) in enumerate(cells):
            maps.append(MapVisit(
                index=i, start_time=i * 4.0, end_time=i * 4.0 + 3, video_time=i * 4.0 + 1.5,
                image=np.zeros(TILE_SHAPE, np.uint8),
                sharpness=1.0, head=[], tail=[], coords=(cx, cy), source=source,
                confidence=0.92 if source == "ocr" else 0.5,
            ))
        links = sorted({tuple(sorted(((cx, cy), n))) for cx, cy, _ in cells
                        for n in ((cx + 1, cy), (cx, cy + 1)) if n in coords})
        export_zone(maps, slug, name, "mock.mp4", data_dir, links=links)
        update_zone_index(data_dir, slug, name, len(maps))
        written.append(f"{slug} ({len(maps)} maps)")
    return written


def clean_mock_zones(data_dir: Path) -> None:
    for path in data_dir.glob(f"{PREFIX}*"):
        shutil.rmtree(path)
    index = data_dir / "zones.json"
    if index.is_file():
        zones = [z for z in json.loads(index.read_text())["zones"]
                 if not z["zone"].startswith(PREFIX)]
        if zones:
            index.write_text(json.dumps({"zones": zones}, indent=2, ensure_ascii=False) + "\n")
        else:
            index.unlink()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m archimap.mock", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--clean", action="store_true", help="remove the mock zones")
    p.add_argument("--data-dir", type=Path,
                   help="where zone folders are written (default: <repo>/web/public/data)")
    args = p.parse_args(argv)
    data_dir = args.data_dir or find_repo_root(Path.cwd()) / "web" / "public" / "data"
    if args.clean:
        clean_mock_zones(data_dir)
        print(f"Removed mock zones from {data_dir}")
    else:
        for line in write_mock_zones(data_dir):
            print(f"  {line}")
        print(f"Mock zones written to {data_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
