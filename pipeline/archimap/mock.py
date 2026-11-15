"""CLI: write mock zones so the web app can be tried without a video.

    python -m archimap.mock          # write the mock zones
    python -m archimap.mock --clean  # remove them again
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import zlib
from pathlib import Path

import cv2
import numpy as np

from .export import export_zone, update_zone_index
from .extract import find_repo_root
from .models import MapVisit

TILE_W, TILE_H = 742, 432
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


def render_tile(x: int, y: int, neighbours: set[tuple[int, int]], seed: int) -> np.ndarray:
    """A cave-looking map: dark floor, isometric grid, rocks, lit exits."""
    rng = np.random.default_rng(seed)
    base = np.array([28, 38, 52]) + rng.integers(-6, 7, 3)  # BGR earthy brown
    img = np.zeros((TILE_H, TILE_W, 3), np.uint8)
    img[:] = base
    noise = rng.normal(0, 7, (TILE_H // 6, TILE_W // 6, 1))
    noise = cv2.resize(noise, (TILE_W, TILE_H), interpolation=cv2.INTER_CUBIC)[..., None]
    img = np.clip(img + noise, 0, 255).astype(np.uint8)

    # Exits toward neighbouring maps: a lighter path from the centre.
    cx, cy = TILE_W // 2, TILE_H // 2
    floor = tuple(int(c) for c in base + 28)
    for (nx, ny), end in {
        (x - 1, y): (0, cy), (x + 1, y): (TILE_W, cy),
        (x, y - 1): (cx, 0), (x, y + 1): (cx, TILE_H),
    }.items():
        if (nx, ny) in neighbours:
            cv2.line(img, (cx, cy), end, floor, 70)
    cv2.ellipse(img, (cx, cy), (150, 90), 0, 0, 360, floor, -1)

    # Isometric grid, as on Dofus maps.
    grid = img.copy()
    for k in range(-TILE_H, TILE_W + TILE_H, 54):
        cv2.line(grid, (k, 0), (k + TILE_H * 2, TILE_H), (0, 0, 0), 1)
        cv2.line(grid, (k, 0), (k - TILE_H * 2, TILE_H), (0, 0, 0), 1)
    img = cv2.addWeighted(grid, 0.25, img, 0.75, 0)

    # Rocks, kept off the central floor.
    for _ in range(rng.integers(6, 14)):
        rx, ry = int(rng.integers(0, TILE_W)), int(rng.integers(0, TILE_H))
        if abs(rx - cx) < 170 and abs(ry - cy) < 110:
            continue
        axes = (int(rng.integers(18, 55)), int(rng.integers(12, 34)))
        shade = int(rng.integers(55, 95))
        cv2.ellipse(img, (rx, ry + 6), axes, 0, 0, 360, (12, 16, 20), -1)
        cv2.ellipse(img, (rx, ry), axes, 0, 0, 360, (shade - 10, shade, shade + 12), -1)
        cv2.ellipse(img, (rx - axes[0] // 4, ry - axes[1] // 3),
                    (axes[0] // 3, axes[1] // 4), 0, 0, 360, (shade + 30,) * 3, -1)

    label = f"[{x},{y}]"
    cv2.putText(img, label, (14, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5, cv2.LINE_AA)
    cv2.putText(img, label, (14, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (235, 235, 235), 2, cv2.LINE_AA)
    return img


def write_mock_zones(data_dir: Path) -> list[str]:
    written = []
    for slug, (name, origin, rows) in ZONES.items():
        cells = _layout(rows, origin)
        coords = {(cx, cy) for cx, cy, _ in cells}
        maps = []
        for i, (cx, cy, source) in enumerate(cells):
            maps.append(MapVisit(
                index=i, start_time=i * 4.0, end_time=i * 4.0 + 3, video_time=i * 4.0 + 1.5,
                image=render_tile(cx, cy, coords, seed=zlib.crc32(f"{slug}:{cx},{cy}".encode())),
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
