"""CLI: build zones from the Dofus Retro client's own map data.

    python -m archimap.client_zones list [SEARCH]   # sub-areas, with map counts
    python -m archimap.client_zones import          # every zones/<zone>.json with "client_subarea"

The game client caches its data (maps with their [x,y] and sub-area) as
Flash shared objects; the newest copy is found automatically on macOS and
Windows, or given with --client-data. A zone is defined in zones/<zone>.json:

    {"client_subarea": 75, "name": "Égouts de Brâkmar", "add_links": [], "remove_links": []}

The client data has no passages between maps, so every pair of
neighbouring maps is joined; fix walls with "remove_links". When a zone
also has a recording, its maps and walked passages are kept and only the
maps the recording missed are added (without screenshots).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .corrections import apply_link_corrections
from .export import update_zone_index
from .sol import read_sol

Coords = tuple[int, int]
# Tile aspect for zones without screenshots: the game area of a full-window capture.
DEFAULT_TILE_SIZE = [1371, 839]
_SO_ROOTS = [
    "~/Library/Application Support/Dofus Retro/Pepper Data/Shockwave Flash/WritableRoot/#SharedObjects",
    os.path.join(os.environ.get("APPDATA", "~/AppData/Roaming"),
                 "Dofus Retro/Pepper Data/Shockwave Flash/WritableRoot/#SharedObjects"),
]


@dataclass
class ClientData:
    maps: dict[int, list[Coords]]  # sub-area id -> map coordinates (may repeat)
    subareas: dict[int, tuple[str, str]]  # id -> (name, area name)
    source: Path


def find_client_data() -> Path | None:
    """Newest cached maps file (ANKXTRASO_*_MA.sol) of an installed client."""
    found = []
    for root in _SO_ROOTS:
        pattern = os.path.join(os.path.expanduser(root), "*", "localhost", "**", "ANKXTRASO_*_MA.sol")
        found += glob.glob(pattern, recursive=True)
    return Path(max(found, key=os.path.getmtime)) if found else None


def load_client_data(path: Path) -> ClientData:
    data = read_sol(path)["_Data"]["MA"]
    areas = {int(k): v.get("n", "?") for k, v in data["a"].items()}
    subareas = {int(k): (v.get("n", "?"), areas.get(int(v.get("a", -1)), "?"))
                for k, v in data["sa"].items()}
    maps: dict[int, list[Coords]] = {}
    for m in data["m"].values():
        maps.setdefault(int(m["sa"]), []).append((int(m["x"]), int(m["y"])))
    return ClientData(maps, subareas, path)


def neighbour_links(cells: set[Coords]) -> list[tuple[Coords, Coords]]:
    return sorted(((x, y), n) for x, y in cells for n in ((x + 1, y), (x, y + 1)) if n in cells)


def build_zone(slug: str, config: dict, client: ClientData, existing: dict | None,
               config_path: Path) -> tuple[dict, list[str]]:
    """zone.json content for a configured zone, merged with a recorded one if any."""
    subarea = int(config["client_subarea"])
    cells = set(client.maps.get(subarea, []))
    if not cells:
        raise ValueError(f"sub-area {subarea} has no maps in {client.source.name}")
    name = config.get("name") or client.subareas[subarea][0]
    notes = []
    if existing:
        maps = list(existing["maps"])
        recorded = {(m["x"], m["y"]) for m in maps}
        added = sorted(cells - recorded)
        maps += [{"x": x, "y": y, "source": "client"} for x, y in added]
        links = {((l[0], l[1]), (l[2], l[3])) for l in existing.get("links", [])}
        # Maps without a recording: assume they connect to their neighbours.
        links |= {link for link in neighbour_links(cells | recorded) if set(link) & set(added)}
        notes.append(f"{len(added)} map(s) added to the {len(recorded)} recorded ones")
        zone = {**existing, "name": name, "maps": maps}
    else:
        maps = [{"x": x, "y": y, "source": "client"} for x, y in sorted(cells, key=lambda c: (c[1], c[0]))]
        links = set(neighbour_links(cells))
        zone = {"zone": slug, "name": name, "source_video": None,
                "tile_size": DEFAULT_TILE_SIZE, "maps": maps}
        notes.append(f"{len(maps)} maps")
    all_cells = {(m["x"], m["y"]) for m in zone["maps"]}
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
    p.add_argument("--data-dir", type=Path,
                   help="where zone folders are written (default: <repo>/web/public/data)")
    args = p.parse_args(argv)

    source = args.client_data or find_client_data()
    if source is None or not source.is_file():
        print("error: Dofus Retro client data not found. Start the game once, or pass --client-data.",
              file=sys.stderr)
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
    configs = sorted((root / "zones").glob("*.json"))
    imported = 0
    for config_path in configs:
        config = json.loads(config_path.read_text())
        if "client_subarea" not in config:
            continue
        slug = config_path.stem
        zone_json = data_dir / slug / "zone.json"
        existing = json.loads(zone_json.read_text()) if zone_json.is_file() else None
        zone, notes = build_zone(slug, config, client, existing, config_path)
        zone_json.parent.mkdir(parents=True, exist_ok=True)
        zone_json.write_text(json.dumps(zone, indent=2, ensure_ascii=False) + "\n")
        update_zone_index(data_dir, slug, zone["name"], len(zone["maps"]))
        print(f"  {slug}: {zone['name']}: " + "; ".join(notes))
        imported += 1
    if not imported:
        print('No zones/<zone>.json with "client_subarea" found.', file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
