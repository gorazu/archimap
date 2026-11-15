"""Write tiles, thumbnails and zone.json for the web map."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import cv2
from PIL import Image

from .models import MapVisit

THUMB_WIDTH = 96


def to_pil(image) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


def export_zone(maps: list[MapVisit], zone: str, name: str, source_video: str,
                data_dir: Path, quality: int = 80,
                links: list[tuple[tuple[int, int], tuple[int, int]]] = ()) -> Path:
    """Replace the zone's tiles and thumbs and write zone.json.

    `links` are the passages between maps, drawn as corridors on the web plan.
    """
    zone_dir = data_dir / zone
    for sub in ("tiles", "thumbs"):
        shutil.rmtree(zone_dir / sub, ignore_errors=True)
        (zone_dir / sub).mkdir(parents=True)

    entries = []
    for visit in maps:
        x, y = visit.coords
        stem = f"{x}_{y}"
        image = to_pil(visit.image)
        image.save(zone_dir / "tiles" / f"{stem}.webp", quality=quality)
        w, h = image.size
        thumb = image.resize((THUMB_WIDTH, max(1, round(h * THUMB_WIDTH / w))),
                             Image.Resampling.LANCZOS)
        thumb.save(zone_dir / "thumbs" / f"{stem}.png")
        entries.append({
            "x": x,
            "y": y,
            "tile": f"tiles/{stem}.webp",
            "thumb": f"thumbs/{stem}.png",
            "source": visit.source,
            "confidence": round(visit.confidence, 3),
            "video_time": round(visit.video_time, 2),
        })

    tile_size = [0, 0]
    if maps:
        h, w = maps[0].image.shape[:2]
        tile_size = [w, h]
    zone_json = {
        "zone": zone,
        "name": name,
        "source_video": source_video,
        "tile_size": tile_size,
        "maps": entries,
        "links": [[a[0], a[1], b[0], b[1]] for a, b in links],
    }
    path = zone_dir / "zone.json"
    path.write_text(json.dumps(zone_json, indent=2, ensure_ascii=False) + "\n")
    return path


def update_zone_index(data_dir: Path, zone: str, name: str, map_count: int) -> Path:
    """Add or replace the zone's entry in zones.json, which lists zones for the web app."""
    path = data_dir / "zones.json"
    zones = json.loads(path.read_text())["zones"] if path.is_file() else []
    zones = [z for z in zones if z["zone"] != zone]
    zones.append({"zone": zone, "name": name, "maps": map_count})
    zones.sort(key=lambda z: z["name"].casefold())
    path.write_text(json.dumps({"zones": zones}, indent=2, ensure_ascii=False) + "\n")
    return path
