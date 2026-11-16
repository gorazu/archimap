"""Passages between maps from the game client's map files: the "suns".

Each map file (data/maps/<id>_<date>.swf) holds the map's cells. Cells that
change map (movement type 2, or drawing the sun graphic on either object
layer: zones differ) on an edge of the map mean a passage to the
neighbouring map on that side; inside a closed room (ladder,
door), their direction from the room's centre is used instead.

Only unencrypted map files are read: the client ships older plain versions
alongside the current encrypted ones ("..X.swf"). Maps without one fall
back to being joined to all their neighbours. Checked on Égouts de Bonta:
every one of the 83 passages walked in the recording is found.
"""

from __future__ import annotations

import glob
import os
import struct
import zlib
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

Coords = tuple[int, int]
Link = tuple[Coords, Coords]

_HASH = {c: i for i, c in enumerate("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")}
# Movement type of the cells that change map, and the sun graphic drawn on
# them. Some zones only set one of the two, on either object layer.
TRIGGER_MOVEMENT = 2
SUN_GRAPHIC = 1030
# Triggers this close to an edge (in half-cells) lead through that edge.
EDGE_MARGIN = 4
SIDES = {"right": (1, 0), "left": (-1, 0), "bottom": (0, 1), "top": (0, -1)}
_MAPS_DIRS = [
    "/Applications/*/Retro/*.app/Contents/Resources/app/retroclient/data/maps",
    "/Applications/*/*.app/Contents/Resources/app/retroclient/data/maps",
    "~/Applications/*/Retro/*.app/Contents/Resources/app/retroclient/data/maps",
    os.path.join(os.environ.get("LOCALAPPDATA", "~/AppData/Local"), "Ankama/*/resources/app/retroclient/data/maps"),
    os.path.join(os.environ.get("LOCALAPPDATA", "~/AppData/Local"), "*/Retro/resources/app/retroclient/data/maps"),
]


def find_maps_dir() -> Path | None:
    """The installed client's map folder (not a beta install, when there is a choice)."""
    found = [p for pattern in _MAPS_DIRS for p in glob.glob(os.path.expanduser(pattern))]
    found.sort(key=lambda p: ("beta" in p.lower(), p))
    return Path(found[0]) if found else None


def plain_map_file(maps_dir: Path, map_id: int) -> Path | None:
    """Newest unencrypted file of a map, if the client has one."""
    files = sorted(p for p in maps_dir.glob(f"{map_id}_*.swf") if not p.stem.endswith("X"))
    return files[-1] if files else None


def swf_variables(path: Path) -> dict[str, object]:
    """Variables a map SWF sets in its ActionScript (width, height, mapData...)."""
    raw = path.read_bytes()
    body = zlib.decompress(raw[8:]) if raw[:3] == b"CWS" else raw[8:]
    pos = (5 + 4 * (body[0] >> 3) + 7) // 8 + 4  # frame RECT, then frame rate and count
    variables: dict[str, object] = {}
    while pos + 2 <= len(body):
        code, length = body[pos + 1] << 2 | body[pos] >> 6, body[pos] & 0x3F
        pos += 2
        if length == 0x3F:
            length = struct.unpack_from("<I", body, pos)[0]
            pos += 4
        if code == 12:  # DoAction
            variables.update(_run_actions(body[pos:pos + length]))
        pos += length
    return variables


def _run_actions(code: bytes) -> dict[str, object]:
    """Interpret just enough AVM1 (constant pool, push, set variable)."""
    constants: list[str] = []
    stack: list[object] = []
    out: dict[str, object] = {}
    pos = 0
    while pos < len(code) and code[pos] != 0:
        action = code[pos]
        pos += 1
        length = 0
        if action >= 0x80:
            length = struct.unpack_from("<H", code, pos)[0]
            pos += 2
        data = code[pos:pos + length]
        if action == 0x88:  # ConstantPool
            constants = [s.decode("utf-8", "replace") for s in data[2:].split(b"\0")[:-1]]
        elif action == 0x96:  # Push
            i = 0
            while i < len(data):
                kind = data[i]
                i += 1
                if kind == 0:
                    end = data.index(b"\0", i)
                    stack.append(data[i:end].decode("utf-8", "replace"))
                    i = end + 1
                elif kind == 1:
                    stack.append(struct.unpack_from("<f", data, i)[0])
                    i += 4
                elif kind in (2, 3):
                    stack.append(None)
                elif kind == 4:
                    stack.append(None)
                    i += 1
                elif kind == 5:
                    stack.append(bool(data[i]))
                    i += 1
                elif kind == 6:  # double: two little-endian halves, high first
                    stack.append(struct.unpack("<d", data[i + 4:i + 8] + data[i:i + 4])[0])
                    i += 8
                elif kind == 7:
                    stack.append(struct.unpack_from("<i", data, i)[0])
                    i += 4
                elif kind == 8:
                    stack.append(constants[data[i]])
                    i += 1
                elif kind == 9:
                    stack.append(constants[struct.unpack_from("<H", data, i)[0]])
                    i += 2
                else:
                    raise ValueError(f"unsupported push type {kind}")
        elif action == 0x1D and len(stack) >= 2:  # SetVariable
            value, name = stack.pop(), stack.pop()
            out[str(name)] = value
        pos += length
    return out


@dataclass(frozen=True)
class Exit:
    side: str  # side of the map it leads through
    t: float  # position along that side, 0..1 (top to bottom, or left to right)
    inner: bool = False  # inside a closed room (ladder, door) rather than on the edge
    uv: tuple[float, float] | None = None  # its sun in the tile, 0..1 from the top-left corner


@dataclass
class Area:
    """A part of a map you can walk around in, with its own exits.

    Some maps (Forêt maléfique) are split into separate parts, each reached
    through different suns.
    """
    center: tuple[float, float]  # (u, v) in the tile, 0..1 from the top-left corner
    exits: list[Exit]
    # Walking routes between the area's suns, over its floor: polylines of (u, v).
    paths: list[list[tuple[float, float]]] = field(default_factory=list)


@dataclass(frozen=True)
class Passage:
    a: tuple[Coords, int]  # map and area index
    b: tuple[Coords, int]
    t: float  # where it crosses the edge shared by the two maps, 0..1 along it
    # The suns it leaves a and enters b by, as (u, v) in their tiles (None if unknown).
    ua: tuple[float, float] | None = None
    ub: tuple[float, float] | None = None


def read_cells(variables: dict[str, object]) -> tuple[dict[tuple[int, int], tuple[bool, bool]], int, int]:
    """(walkable, has a sun) per cell position, and the grid size, in half-cell units.

    Cells come in rows of `width` then `width - 1` cells, offset by half a
    cell: x runs 0..2*width-2 across the screen, y 0..2*height-2 down it.
    """
    width, height = int(variables["width"]), int(variables["height"])
    data = str(variables["mapData"])
    cells = {}
    for cell_id, k in enumerate(range(0, len(data) - 9, 10)):
        c = [_HASH[ch] for ch in data[k:k + 10]]
        active, movement = (c[0] & 32) >> 5, (c[2] & 56) >> 3
        layer1 = ((c[0] & 4) << 11) + ((c[4] & 1) << 12) + (c[5] << 6) + c[6]
        layer2 = ((c[0] & 2) << 12) + ((c[7] & 1) << 12) + (c[8] << 6) + c[9]
        sun = bool(active and movement == TRIGGER_MOVEMENT) or SUN_GRAPHIC in (layer1, layer2)
        pair, rest = divmod(cell_id, 2 * width - 1)
        pos = (rest * 2, pair * 2) if rest < width else ((rest - width) * 2 + 1, pair * 2 + 1)
        cells[pos] = (bool(active and movement != 0) or sun, sun)
    return cells, 2 * width - 2, 2 * height - 2


# Out of fights, characters move in 8 directions: diagonals on the grid
# above are the 4 "straight" steps, (±2, 0) and (0, ±2) the other 4.
_STEPS = ((1, 1), (1, -1), (-1, 1), (-1, -1), (2, 0), (-2, 0), (0, 2), (0, -2))
# Suns closer than this (along the side, 0..1) form one exit.
_CLUSTER_GAP = 0.12


def _exits(suns: list[tuple[int, int]], cols: int, rows: int) -> list[tuple[Exit, tuple[int, int]]]:
    """Exits from sun cells (suns close together form one), each with the sun
    cell that stands for it."""
    found: dict[tuple[str, bool], list[tuple[float, tuple[int, int]]]] = {}
    for x, y in suns:
        near = [side for side, ok in (("left", x <= EDGE_MARGIN), ("right", x >= cols - EDGE_MARGIN),
                                      ("top", y <= EDGE_MARGIN), ("bottom", y >= rows - EDGE_MARGIN)) if ok]
        if not near:  # inside a closed room: pointing away from the centre
            dx, dy = x - cols / 2, y - rows / 2
            near = [("right" if dx > 0 else "left") if abs(dx) > abs(dy) else ("bottom" if dy > 0 else "top")]
        for side in near:
            t = y / rows if side in ("left", "right") else x / cols
            found.setdefault((side, len(near) == 1 and not _on_edge(x, y, cols, rows)), []).append((t, (x, y)))
    exits = []
    for (side, inner), suns_on_side in found.items():
        suns_on_side.sort()
        group = [suns_on_side[0]]
        for item in suns_on_side[1:] + [None]:
            if item is not None and item[0] - group[-1][0] <= _CLUSTER_GAP:
                group.append(item)
                continue
            t = sum(g[0] for g in group) / len(group)
            cell = min(group, key=lambda g: abs(g[0] - t))[1]
            uv = (round(cell[0] / cols, 3), round(cell[1] / rows, 3))
            exits.append((Exit(side, round(t, 3), inner, uv), cell))
            if item is not None:
                group = [item]
    return exits


def _route(part: set[tuple[int, int]], start: tuple[int, int], goal: set[tuple[int, int]]) -> list[tuple[int, int]]:
    """Shortest walk over the part's cells from start to any cell of goal."""
    previous = {start: start}
    queue = deque([start])
    while queue:
        p = queue.popleft()
        if p in goal:
            path = [p]
            while path[-1] != start:
                path.append(previous[path[-1]])
            return path[::-1]
        for dx, dy in _STEPS:
            q = (p[0] + dx, p[1] + dy)
            if q in part and q not in previous:
                previous[q] = p
                queue.append(q)
    return [start]


def _straighten(path: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Drop the points in the middle of straight stretches."""
    out = path[:2]
    for p in path[2:]:
        a, b = out[-2], out[-1]
        if (b[0] - a[0], b[1] - a[1]) == (p[0] - b[0], p[1] - b[1]):
            out[-1] = p
        else:
            out.append(p)
    return out


def _area_paths(part: set[tuple[int, int]], exit_cells: list[tuple[int, int]],
                cols: int, rows: int) -> list[list[tuple[float, float]]]:
    """Routes joining the part's exits over its floor, as a small tree. A part
    with a single exit gets a route to its middle (a dead end)."""
    cells = list(dict.fromkeys(exit_cells))
    if len(cells) == 1:
        cx = sum(x for x, _ in part) / len(part)
        cy = sum(y for _, y in part) / len(part)
        cells.append(min(part, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2))
    tree = {cells[0]}
    routes = []
    for cell in cells[1:]:
        route = _route(part, cell, tree)
        tree.update(route)
        if len(route) > 1:
            routes.append([(round(x / cols, 3), round(y / rows, 3)) for x, y in _straighten(route)])
    return routes


def _on_edge(x: int, y: int, cols: int, rows: int) -> bool:
    return x <= EDGE_MARGIN or x >= cols - EDGE_MARGIN or y <= EDGE_MARGIN or y >= rows - EDGE_MARGIN


def map_areas(variables: dict[str, object]) -> list[Area]:
    """The walkable parts of a map that have exits."""
    cells, cols, rows = read_cells(variables)
    seen: set[tuple[int, int]] = set()
    areas = []
    for start, (walkable, _) in cells.items():
        if not walkable or start in seen:
            continue
        part, stack = [], [start]
        while stack:
            p = stack.pop()
            if p in seen or not cells.get(p, (False, False))[0]:
                continue
            seen.add(p)
            part.append(p)
            stack += [(p[0] + dx, p[1] + dy) for dx, dy in _STEPS]
        suns = [p for p in part if cells[p][1]]
        if suns:
            center = (round(sum(x for x, _ in part) / len(part) / cols, 3),
                      round(sum(y for _, y in part) / len(part) / rows, 3))
            exits = _exits(suns, cols, rows)
            paths = _area_paths(set(part), [cell for _, cell in exits], cols, rows)
            areas.append(Area(center, [e for e, _ in exits], paths))
    return areas


def read_areas(maps: dict[Coords, list[int]], maps_dir: Path) -> tuple[dict[Coords, list[Area]], set[Coords]]:
    """Areas of every map (several map ids on one cell are pooled); also the
    maps that had no readable map file."""
    areas: dict[Coords, list[Area]] = {}
    unreadable = set()
    for coords, map_ids in maps.items():
        files = [f for f in (plain_map_file(maps_dir, i) for i in map_ids) if f]
        if not files:
            unreadable.add(coords)
            continue
        areas[coords] = [a for f in files for a in map_areas(swf_variables(f))]
    return areas, unreadable


def passages_between(areas: dict[Coords, list[Area]]) -> list[Passage]:
    """Passages between areas of neighbouring maps.

    Two maps connect when one has an edge exit towards the other and the
    other has any exit back, or when a closed room's inner exit points at
    the other (checked on Égouts de Bonta against a recording). Suns aren't
    mirrored between maps in general (you leave by one cell and arrive
    elsewhere), so their positions only decide which areas connect when
    both maps are split into several parts (Forêt maléfique): exits pair by
    position along the shared edge. When one side has a single area, every
    area of the other side with an exit connects to it.
    """
    passages = []
    for (x, y) in sorted(areas):
        for side in ("right", "bottom"):  # each neighbour pair once
            dx, dy = SIDES[side]
            other = (x + dx, y + dy)
            if other not in areas:
                continue
            back = "left" if side == "right" else "top"
            here = [(i, e) for i, part in enumerate(areas[(x, y)]) for e in part.exits if e.side == side]
            there = [(j, e) for j, part in enumerate(areas[other]) for e in part.exits if e.side == back]
            connected = ((any(not e.inner for _, e in here) and there) or any(e.inner for _, e in here)
                         or (any(not e.inner for _, e in there) and here) or any(e.inner for _, e in there))
            if not connected:
                continue
            for (i, j), (t, ua, ub) in _pair_areas(here, there).items():
                passages.append(Passage(((x, y), i), (other, j), t, ua, ub))
    return passages


def _pair_areas(here: list[tuple[int, Exit]], there: list[tuple[int, Exit]]
                ) -> dict[tuple[int, int], tuple[float, tuple | None, tuple | None]]:
    """Which area here connects to which area there: where they cross the
    edge, and the suns used on each side."""
    # A room's inner exit may face no exit on the other map: use the first
    # area there, entered at an unknown place.
    if not here or not there:
        known = here or there
        pairs = {}
        for k, e in known:
            key = (k, 0) if here else (0, k)
            pairs.setdefault(key, (e.t, e.uv if here else None, None if here else e.uv))
        return pairs
    pairs: dict[tuple[int, int], tuple[float, tuple | None, tuple | None]] = {}
    if len({i for i, _ in here}) == 1 or len({j for j, _ in there}) == 1:
        for i, a in here:
            for j, b in there:
                pairs.setdefault((i, j), (round((a.t + b.t) / 2, 3), a.uv, b.uv))
        return pairs
    # Both maps split: pair exits by position along the edge, closest first.
    used_here, used_there = set(), set()
    for distance, (k, (i, a)), (m, (j, b)) in sorted(
            ((abs(a.t - b.t), (k, (i, a)), (m, (j, b)))
             for k, (i, a) in enumerate(here) for m, (j, b) in enumerate(there)), key=lambda o: o[0]):
        if k in used_here or m in used_there:
            continue
        used_here.add(k)
        used_there.add(m)
        pairs.setdefault((i, j), (round((a.t + b.t) / 2, 3), a.uv, b.uv))
    return pairs


def sun_passages(maps: dict[Coords, list[int]], maps_dir: Path
                 ) -> tuple[dict[Coords, list[Area]], list[Passage], set[Coords]]:
    """Areas and passages from the map files; also the maps without a readable file."""
    areas, unreadable = read_areas(maps, maps_dir)
    return areas, passages_between(areas), unreadable


def sun_links(maps: dict[Coords, list[int]], maps_dir: Path) -> tuple[set[Link], set[Coords]]:
    """Map-level passages (which maps connect), and the maps without a readable file."""
    _, passages, unreadable = sun_passages(maps, maps_dir)
    return {(p.a[0], p.b[0]) for p in passages}, unreadable


# Map layouts for the plan: each cell is 0 off-map, 1 wall/obstacle, 2 floor
# or 3 sun, packed 3 cells per character (base64url alphabet, little end first).
_LAYOUT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def map_layout(variables: dict[str, object]) -> dict[str, object]:
    """The map's cells, compact: {"w": width, "h": height, "cells": packed string}."""
    width, height = int(variables["width"]), int(variables["height"])
    data = str(variables["mapData"])
    values = []
    for k in range(0, len(data) - 9, 10):
        c = [_HASH[ch] for ch in data[k:k + 10]]
        active, movement = (c[0] & 32) >> 5, (c[2] & 56) >> 3
        layer1 = ((c[0] & 4) << 11) + ((c[4] & 1) << 12) + (c[5] << 6) + c[6]
        layer2 = ((c[0] & 2) << 12) + ((c[7] & 1) << 12) + (c[8] << 6) + c[9]
        if (active and movement == TRIGGER_MOVEMENT) or SUN_GRAPHIC in (layer1, layer2):
            values.append(3)
        elif not active:
            values.append(0)
        else:
            values.append(2 if movement != 0 else 1)
    values += [0] * (-len(values) % 3)
    cells = "".join(_LAYOUT_ALPHABET[values[i] + 4 * values[i + 1] + 16 * values[i + 2]]
                    for i in range(0, len(values), 3))
    return {"w": width, "h": height, "cells": cells}


def read_layouts(maps: dict[Coords, list[int]], maps_dir: Path) -> dict[Coords, dict[str, object]]:
    """Layout of each map that has a readable file (the first one, when
    several maps share a cell)."""
    layouts = {}
    for coords, map_ids in maps.items():
        path = next((f for f in (plain_map_file(maps_dir, i) for i in map_ids) if f), None)
        if path:
            layouts[coords] = map_layout(swf_variables(path))
    return layouts
