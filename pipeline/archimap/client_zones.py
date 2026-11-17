"""CLI: build zones from the Dofus Retro client's own map data.

    python -m archimap.client_zones list [SEARCH]   # sub-areas, with map counts
    python -m archimap.client_zones import          # every zones/<zone>.json with "client_subarea" or "parts"

The game client caches its data (maps with their [x,y] and sub-area) as
Flash shared objects; the newest copy is found automatically on macOS and
Windows, or given with --client-data. A zone is defined in zones/<zone>.json:

    {"client_subarea": 75, "name": "Égouts de Brâkmar", "add_links": [], "remove_links": []}

Sub-areas that lead into each other can make one zone, checked as one, with
"parts" instead of "client_subarea"; each part can still be shown alone:

    {"name": "Souterrains d'Astrub", "parts": [
        {"client_subarea": 99, "part": "souterrain-astrub", "name": "Souterrain d'Astrub"}, ...]}

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

from .client_maps import Passage, find_entrances, find_maps_dir, read_layouts, sun_on_side, sun_passages
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


def zone_parts(config: dict) -> list[dict]:
    """The zone's sub-areas: its "parts", or its one "client_subarea"."""
    if "parts" in config:
        return config["parts"]
    return [{"client_subarea": config["client_subarea"]}]


def zone_entrances(found, config: dict, client: ClientData, subareas: list[int]) -> list[dict]:
    """Entrances for zone.json: detected ones (minus "remove_entrances"), each
    with the names of the sub-areas it leads to, plus "entrances" listed by
    hand in the zone's config (an NPC, for example)."""
    names: dict[Coords, set[str]] = {}
    for sid, maps in client.maps.items():
        for _, coords in maps:
            names.setdefault(coords, set()).add(client.subareas[sid][0])
    removed = {tuple(c) for c in config.get("remove_entrances", [])}
    out = []
    for e in found:
        if e.coords in removed:
            continue
        # Names starting with "//" are the game's internal ones ("//Bonta"): keep them, cleaned.
        own = {client.subareas[s][0] for s in subareas}
        towards = sorted({n.lstrip("/") for n in names.get(e.towards, set()) - own})
        entry = {"x": e.coords[0], "y": e.coords[1], "area": e.area, "kind": e.kind,
                 **({"uv": list(e.uv)} if e.uv else {}), "to": ", ".join(towards)}
        # Two ladders of one room to the same place are one entrance.
        if not any((o["x"], o["y"], o["area"], o["kind"], o["to"]) == (entry["x"], entry["y"], entry["area"], entry["kind"], entry["to"])
                   for o in out):
            out.append(entry)
    for e in config.get("entrances", []):
        out.append({"x": e["x"], "y": e["y"], "area": e.get("area", 0), "kind": "manual", "to": e.get("label", "")})
    return out


def added_passages(config: dict, areas) -> list:
    """Passages listed by hand in the zone's config, from a sun to a sun, for
    the ones the map files can't tell: a sun leading to a map that isn't its
    neighbour on that side, for example. Each end is [x, y, side], or [x, y]
    for a map entered with no sun to go back by."""
    out = []
    for entry in config.get("add_passages", []):
        ends = []
        for x, y, *side in (entry["a"], entry["b"]):
            area, uv = sun_on_side(areas, (x, y), side[0]) if side else (0, None)
            ends.append(((x, y), area, uv))
        (a, ia, ua), (b, ib, ub) = sorted(ends, key=lambda end: end[0])
        out.append(Passage((a, ia), (b, ib), ua[1] if ua else 0.5, ua, ub))
    return out


def build_zone(slug: str, config: dict, client: ClientData, existing: dict | None,
               config_path: Path, maps_dir: Path | None = None) -> tuple[dict, list[str]]:
    """zone.json content for a configured zone, merged with a recorded one if any.

    Passages come from the map files' suns (`maps_dir`), plus the passages
    walked in the recording; maps without a readable map file are joined to
    all their neighbours.
    """
    parts = zone_parts(config)
    subareas = [int(part["client_subarea"]) for part in parts]
    by_coords: dict[Coords, list[int]] = {}
    subarea_of: dict[Coords, str] = {}
    for subarea in subareas:
        if not client.maps.get(subarea):
            raise ValueError(f"sub-area {subarea} has no maps in {client.source.name}")
        for map_id, coords in client.maps[subarea]:
            by_coords.setdefault(coords, []).append(map_id)
            subarea_of[coords] = client.subareas[subarea][0]
    cells = set(by_coords)
    name = config.get("name") or client.subareas[subareas[0]][0]
    notes = []
    areas, passages, unreadable = sun_passages(by_coords, maps_dir) if maps_dir else ({}, [], cells)
    layouts = read_layouts(by_coords, maps_dir) if maps_dir else {}
    passages += added_passages(config, areas)
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
        m.pop("paths", None)
        m.pop("subarea", None)
        if len(parts) > 1 and (m["x"], m["y"]) in subarea_of:
            m["subarea"] = subarea_of[(m["x"], m["y"])]
        if areas.get((m["x"], m["y"])):
            m["areas"] = [list(a.center) for a in areas[(m["x"], m["y"])]]
            # Walking routes between the map's suns, over its floor.
            m["paths"] = [[list(p) for p in route] for a in areas[(m["x"], m["y"])] for route in a.paths]
        # The map's own layout (floor, walls, suns), drawn inside its plan tile.
        if (m["x"], m["y"]) in layouts:
            m["layout"] = layouts[(m["x"], m["y"])]
    zone["entrances"] = zone_entrances(find_entrances(areas, passages), config, client, subareas)
    zone["passages"] = [{"a": [*p.a[0], p.a[1]], "b": [*p.b[0], p.b[1]], "t": p.t,
                         **({"ua": list(p.ua)} if p.ua else {}), **({"ub": list(p.ub)} if p.ub else {}),
                         **({"oneway": p.oneway} if p.oneway else {})}
                        for p in passages]
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
    zone.pop("parts", None)
    if len(parts) > 1:
        zone.pop("client_subarea", None)
        # In-game sub-area name and map count of each part, for showing one part alone.
        zone["parts"] = [{"part": part["part"], "name": part.get("name") or client.subareas[s][0],
                          "subarea": client.subareas[s][0],
                          "maps": sum(m.get("subarea") == client.subareas[s][0] for m in zone["maps"])}
                         for part, s in zip(parts, subareas)]
    else:
        zone["client_subarea"] = subareas[0]
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
        if "client_subarea" not in config and "parts" not in config:
            continue
        slug = config_path.stem
        zone_json = data_dir / slug / "zone.json"
        existing = json.loads(zone_json.read_text()) if zone_json.is_file() else None
        zone, notes = build_zone(slug, config, client, existing, config_path, maps_dir)
        zone_json.parent.mkdir(parents=True, exist_ok=True)
        zone_json.write_text(json.dumps(zone, indent=2, ensure_ascii=False) + "\n")
        update_zone_index(data_dir, slug, zone["name"], len(zone["maps"]),
                          subarea=client.subareas[zone["client_subarea"]][0] if "client_subarea" in zone else None,
                          parts=zone.get("parts"))
        print(f"  {slug}: {zone['name']}: " + "; ".join(notes))
        imported += 1
    if not imported:
        print('No zones/<zone>.json with "client_subarea" or "parts" found.', file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
