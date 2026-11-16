"""CLI: build zones from the Dofus Retro client's own map data.

    python -m archimap.client_zones list [SEARCH]   # sub-areas, with map counts
    python -m archimap.client_zones import          # every zones/<zone>.json with "client_subarea"

The game client caches its data (maps with their [x,y] and sub-area) as
Flash shared objects; the newest copy is found automatically on macOS and
Windows, or given with --client-data. A zone is defined in zones/<zone>.json:

    {"client_subarea": 75, "name": "Égouts de Brâkmar", "add_links": [], "remove_links": []}

Passages come from the "suns" in the client's map files (see
client_maps.py); maps without a readable map file are joined to all their
neighbours. When a zone also has a recording, its maps and walked passages
are kept and only the maps the recording missed are added.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .client_maps import find_maps_dir, read_layouts, sun_passages
from .corrections import apply_link_corrections
from .export import update_zone_index
from .sol import read_sol

Coords = tuple[int, int]
# Tile aspect for zones without screenshots: the game area of a full-window capture.
DEFAULT_TILE_SIZE = [1371, 839]
# Any client's data folder ("Dofus Retro", or a server's own client such as
# "Abrak Retro"): the newest cache wins.
_SO_ROOTS = [
    "~/Library/Application Support/*/Pepper Data/Shockwave Flash/WritableRoot/#SharedObjects",
    os.path.join(os.environ.get("APPDATA", "~/AppData/Roaming"),
                 "*/Pepper Data/Shockwave Flash/WritableRoot/#SharedObjects"),
]


@dataclass
class ClientData:
    maps: dict[int, list[tuple[int, Coords]]]  # sub-area id -> (map id, coordinates)
    subareas: dict[int, tuple[str, str]]  # id -> (name, area name)
    source: Path


def _cache_language(maps_file: Path) -> str | None:
    """Language of a cached data copy, from the language file saved next to it."""
    copy = maps_file.name.split("_")[1]  # ANKXTRASO_<copy>_MA.sol
    lang = maps_file.with_name(f"ANKLANGSO_{copy}.sol")
    try:
        return str(read_sol(lang)["_Data"].get("LANGUAGE")) if lang.is_file() else None
    except (KeyError, ValueError):
        return None


def find_client_data(language: str | None = "fr") -> Path | None:
    """Newest cached maps file (ANKXTRASO_*_MA.sol) of an installed client.

    Sub-area names must be in the game's language (live mode matches them
    with the location line on screen), so only caches in `language` count.
    """
    found = []
    for root in _SO_ROOTS:
        pattern = os.path.join(os.path.expanduser(root), "*", "localhost", "**", "ANKXTRASO_*_MA.sol")
        found += [Path(p) for p in glob.glob(pattern, recursive=True)]
    if language:
        found = [p for p in found if _cache_language(p) == language]
    return max(found, key=os.path.getmtime) if found else None


def load_client_data(path: Path) -> ClientData:
    data = read_sol(path)["_Data"]["MA"]
    areas = {int(k): v.get("n", "?") for k, v in data["a"].items()}
    subareas = {int(k): (v.get("n", "?"), areas.get(int(v.get("a", -1)), "?"))
                for k, v in data["sa"].items()}
    maps: dict[int, list[tuple[int, Coords]]] = {}
    for map_id, m in data["m"].items():
        maps.setdefault(int(m["sa"]), []).append((int(map_id), (int(m["x"]), int(m["y"]))))
    return ClientData(maps, subareas, path)


def neighbour_links(cells: set[Coords]) -> list[tuple[Coords, Coords]]:
    return sorted(((x, y), n) for x, y in cells for n in ((x + 1, y), (x, y + 1)) if n in cells)


def build_zone(slug: str, config: dict, client: ClientData, existing: dict | None,
               config_path: Path, maps_dir: Path | None = None) -> tuple[dict, list[str]]:
    """zone.json content for a configured zone, merged with a recorded one if any.

    Passages come from the map files' suns (`maps_dir`), plus the passages
    walked in the recording; maps without a readable map file are joined to
    all their neighbours.
    """
    subarea = int(config["client_subarea"])
    by_coords: dict[Coords, list[int]] = {}
    for map_id, coords in client.maps.get(subarea, []):
        by_coords.setdefault(coords, []).append(map_id)
    cells = set(by_coords)
    if not cells:
        raise ValueError(f"sub-area {subarea} has no maps in {client.source.name}")
    name = config.get("name") or client.subareas[subarea][0]
    notes = []
    areas, passages, unreadable = sun_passages(by_coords, maps_dir) if maps_dir else ({}, [], cells)
    layouts = read_layouts(by_coords, maps_dir) if maps_dir else {}
    suns = {(p.a[0], p.b[0]) for p in passages}
    if existing:
        maps = list(existing["maps"])
        recorded = {(m["x"], m["y"]) for m in maps if m["source"] != "client"}
        added = sorted(cells - {(m["x"], m["y"]) for m in maps})
        maps += [{"x": x, "y": y, "source": "client"} for x, y in added]
        # Passages walked in a recording; older recorded zones only have "links".
        # Zones built from the client alone have none: their passages are rebuilt.
        route = existing.get("route_links", existing.get("links", []) if recorded else [])
        links = {((l[0], l[1]), (l[2], l[3])) for l in route}
        from_video = sum(m["source"] != "client" for m in existing["maps"])
        notes.append(f"{len(added)} map(s) added to the {from_video} recorded ones" if from_video
                     else f"{len(maps)} maps")
        zone = {**existing, "name": name, "maps": maps}
    else:
        maps = [{"x": x, "y": y, "source": "client"} for x, y in sorted(cells, key=lambda c: (c[1], c[0]))]
        links, recorded = set(), set()
        zone = {"zone": slug, "name": name, "source_video": None,
                "tile_size": DEFAULT_TILE_SIZE, "maps": maps}
        notes.append(f"{len(maps)} maps")
    all_cells = {(m["x"], m["y"]) for m in zone["maps"]}
    # Walkable areas (as tile positions) and the passages between them, for
    # the plan: some maps are split into parts reached through different suns.
    for m in zone["maps"]:
        m.pop("areas", None)
        m.pop("layout", None)
        if areas.get((m["x"], m["y"])):
            m["areas"] = [list(a.center) for a in areas[(m["x"], m["y"])]]
        # The map's own layout (floor, walls, suns), drawn inside its plan tile.
        if (m["x"], m["y"]) in layouts:
            m["layout"] = layouts[(m["x"], m["y"])]
    zone["passages"] = [{"a": [*p.a[0], p.a[1]], "b": [*p.b[0], p.b[1]], "t": p.t} for p in passages]
    links |= suns
    # Without a map file, join to all neighbours, except recorded maps:
    # their walked passages are better than a guess.
    guessed = unreadable - recorded
    links |= {link for link in neighbour_links(all_cells) if set(link) & guessed}
    notes.append(f"{len(suns)} passages from the map files"
                 + (f" ({len(passages)} paths between map areas)" if len(passages) > len(suns) else ""))
    if guessed:
        notes.append(f"{len(guessed)} map(s) without a readable map file joined to all neighbours")
    final, link_notes = apply_link_corrections(links, config_path, all_cells)
    zone["maps"] = sorted(zone["maps"], key=lambda m: (m["y"], m["x"]))
    zone["links"] = [[a[0], a[1], b[0], b[1]] for a, b in final]
    zone["client_subarea"] = subarea
    return zone, notes + link_notes


def main(argv: list[str] | None = None) -> int:
    from .extract import find_repo_root

    p = argparse.ArgumentParser(prog="python -m archimap.client_zones", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["list", "import"])
    p.add_argument("search", nargs="?", default="", help="list: only sub-areas whose name contains this")
    p.add_argument("--client-data", type=Path, help="a cached ANKXTRASO_*_MA.sol file")
    p.add_argument("--client-maps", type=Path, help="the client's data/maps folder (for passages)")
    p.add_argument("--language", default="fr",
                   help="language of the game, for sub-area names (default: fr)")
    p.add_argument("--data-dir", type=Path,
                   help="where zone folders are written (default: <repo>/web/public/data)")
    args = p.parse_args(argv)

    source = args.client_data or find_client_data(args.language)
    if source is None or not source.is_file():
        print(f"error: Dofus Retro client data in '{args.language}' not found. Start the game once "
              "in that language, or pass --client-data.", file=sys.stderr)
        return 2
    client = load_client_data(source)
    print(f"Client data: {source.name} ({sum(map(len, client.maps.values()))} maps)")

    if args.command == "list":
        for sid, (name, area) in sorted(client.subareas.items(), key=lambda s: (s[1][1], s[1][0])):
            if args.search.lower() in name.lower():
                print(f"  {sid:4d}  {name:45s} {area:30s} {len(client.maps.get(sid, [])):4d} maps")
        return 0

    root = find_repo_root(Path.cwd())
    data_dir = args.data_dir or root / "web" / "public" / "data"
    maps_dir = args.client_maps or find_maps_dir()
    print(f"Map files: {maps_dir}" if maps_dir else
          "warning: client map files not found, maps are joined to all their neighbours")
    configs = sorted((root / "zones").glob("*.json"))
    imported = 0
    for config_path in configs:
        config = json.loads(config_path.read_text())
        if "client_subarea" not in config:
            continue
        slug = config_path.stem
        zone_json = data_dir / slug / "zone.json"
        existing = json.loads(zone_json.read_text()) if zone_json.is_file() else None
        zone, notes = build_zone(slug, config, client, existing, config_path, maps_dir)
        zone_json.parent.mkdir(parents=True, exist_ok=True)
        zone_json.write_text(json.dumps(zone, indent=2, ensure_ascii=False) + "\n")
        update_zone_index(data_dir, slug, zone["name"], len(zone["maps"]),
                          subarea=client.subareas[zone["client_subarea"]][0])
        print(f"  {slug}: {zone['name']}: " + "; ".join(notes))
        imported += 1
    if not imported:
        print('No zones/<zone>.json with "client_subarea" found.', file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
