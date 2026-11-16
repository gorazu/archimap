"""Manual corrections to a zone's passages, kept in <repo>/zones/<zone>.json.

    {"add_links": [[x1, y1, x2, y2], ...], "remove_links": [[x1, y1, x2, y2], ...]}

The plan only shows passages walked in the recording, so passages that
weren't walked can be added here, and wrong ones removed. The pipeline
applies the file on every run. To apply it to an already generated zone
without reprocessing the video:

    python -m archimap.corrections egouts-de-bonta

To undo an added passage, move it to "remove_links" (zone.json keeps the
passages already added).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from pathlib import Path

Coords = tuple[int, int]
Link = tuple[Coords, Coords]


def corrections_path(root: Path, zone: str) -> Path:
    return root / "zones" / f"{zone}.json"


def _link(values: list[int]) -> Link:
    if len(values) != 4:
        raise ValueError(f"a link is [x1, y1, x2, y2], got {values}")
    a, b = (values[0], values[1]), (values[2], values[3])
    if abs(a[0] - b[0]) + abs(a[1] - b[1]) != 1:
        raise ValueError(f"[{a[0]},{a[1]}] and [{b[0]},{b[1]}] are not neighbouring maps")
    return tuple(sorted((a, b)))


def apply_link_corrections(links: Iterable[Link], path: Path,
                           maps: set[Coords]) -> tuple[list[Link], list[str]]:
    """Links with the file's additions and removals; also returns notes to print."""
    links = {tuple(sorted(link)) for link in links}
    if not path.is_file():
        return sorted(links), []
    data = json.loads(path.read_text())
    add = {_link(v) for v in data.get("add_links", [])}
    remove = {_link(v) for v in data.get("remove_links", [])}
    notes = []
    for a, b in sorted(add):
        if a not in maps or b not in maps:
            notes.append(f"skipped [{a[0]},{a[1]}]-[{b[0]},{b[1]}]: not a map of this zone")
    add = {link for link in add if link[0] in maps and link[1] in maps}
    added, removed = len(add - links), len(remove & links)
    if added or removed:
        notes.append(f"{added} passage(s) added, {removed} removed by {path.name}")
    return sorted((links | add) - remove), notes


def main(argv: list[str] | None = None) -> int:
    from .extract import find_repo_root

    p = argparse.ArgumentParser(prog="python -m archimap.corrections", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("zone", help="zone slug")
    p.add_argument("--data-dir", type=Path,
                   help="where zone folders are (default: <repo>/web/public/data)")
    args = p.parse_args(argv)
    root = find_repo_root(Path.cwd())
    zone_json = (args.data_dir or root / "web" / "public" / "data") / args.zone / "zone.json"
    corrections = corrections_path(root, args.zone)
    if not zone_json.is_file():
        print(f"error: {zone_json} not found", file=sys.stderr)
        return 2
    if not corrections.is_file():
        print(f"error: {corrections} not found", file=sys.stderr)
        return 2
    zone = json.loads(zone_json.read_text())
    maps = {(m["x"], m["y"]) for m in zone["maps"]}
    current = [((l[0], l[1]), (l[2], l[3])) for l in zone.get("links", [])]
    links, notes = apply_link_corrections(current, corrections, maps)
    zone["links"] = [[a[0], a[1], b[0], b[1]] for a, b in links]
    zone_json.write_text(json.dumps(zone, indent=2, ensure_ascii=False) + "\n")
    for note in notes or ["no change"]:
        print(f"  {note}")
    print(f"Zone data: {zone_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
