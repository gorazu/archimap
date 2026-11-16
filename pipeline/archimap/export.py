"""Write zone.json for the web map."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from .models import MapVisit


def export_zone(maps: list[MapVisit], zone: str, name: str, source_video: str,
                data_dir: Path,
                links: list[tuple[tuple[int, int], tuple[int, int]]] = (),
                route_links: list[tuple[tuple[int, int], tuple[int, int]]] | None = None) -> Path:
    """Write the zone's zone.json.

    `links` are the passages between maps, drawn as corridors on the web plan.
    `route_links` are the ones walked in the recording, kept so passages can
    be rebuilt later from other sources without losing them.
    """
    zone_dir = data_dir / zone
    zone_dir.mkdir(parents=True, exist_ok=True)
    # Screenshots were dropped from the web map: remove any left from older runs.
    for sub in ("tiles", "thumbs"):
        shutil.rmtree(zone_dir / sub, ignore_errors=True)

    entries = [{
        "x": visit.coords[0],
        "y": visit.coords[1],
        "source": visit.source,
        "confidence": round(visit.confidence, 3),
        "video_time": round(visit.video_time, 2),
    } for visit in maps]

    # The game area's size gives the plan tiles their shape.
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
    if route_links is not None:
        zone_json["route_links"] = [[a[0], a[1], b[0], b[1]] for a, b in route_links]
    path = zone_dir / "zone.json"
    path.write_text(json.dumps(zone_json, indent=2, ensure_ascii=False) + "\n")
    return path


def update_zone_index(data_dir: Path, zone: str, name: str, map_count: int,
                      subarea: str | None = None, parts: list[dict] | None = None) -> Path:
    """Add or replace the zone's entry in zones.json, which lists zones for the web app.

    `subarea` is the in-game sub-area name, as shown in the game's location
    line ("Bonta (Egout de Bonta)"); live capture uses it to tell which zone
    the player is in. When not given, the one already listed is kept.
    A zone made of several sub-areas lists them as `parts` instead.
    """
    path = data_dir / "zones.json"
    zones = json.loads(path.read_text())["zones"] if path.is_file() else []
    old = next((z for z in zones if z["zone"] == zone), {})
    zones = [z for z in zones if z["zone"] != zone]
    entry = {"zone": zone, "name": name, "maps": map_count}
    if parts:
        entry["parts"] = parts
    elif subarea or old.get("subarea"):
        entry["subarea"] = subarea or old["subarea"]
    zones.append(entry)
    zones.sort(key=lambda z: z["name"].casefold())
    path.write_text(json.dumps({"zones": zones}, indent=2, ensure_ascii=False) + "\n")
    return path
