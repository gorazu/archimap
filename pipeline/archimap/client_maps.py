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

import collections

import glob
import os
import struct
import zlib
from collections import deque
from dataclasses import dataclass, field, replace
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
    # Walkable one way only: "ab" (a to b) or "ba"; None both ways.
    oneway: str | None = None


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


@dataclass
class SharedCoords:
    """Which maps to use where several share coordinates."""
    maps: dict[Coords, list[int]]  # the main map first, then others that reach another neighbour
    main_areas: dict[Coords, int]  # how many of the areas read come from the main map (drawn)
    rooms: list[Coords]  # left-out rooms with a ladder only: ways in from above


def main_maps(maps: dict[Coords, list[int]], maps_dir: Path, chosen: dict[Coords, int] | None = None) -> SharedCoords:
    """Several maps can share coordinates: versions of the same map, a small
    room with a ladder from the surface, or a map reaching other neighbours.
    The main one, drawn, is the one whose suns best match the neighbouring
    maps' (a sun facing a neighbour with a sun back), then of the usual
    size, then the lowest id; `chosen` picks it by hand. Others are kept for
    their passages only when they reach a neighbour the main one doesn't;
    rooms with only a ladder become ways in."""
    files = {i: plain_map_file(maps_dir, i) for ids in maps.values() for i in ids}
    variables = {i: swf_variables(f) for i, f in files.items() if f}
    areas_of = {i: map_areas(v) for i, v in variables.items()}
    exits = {i: [e for a in areas_of[i] for e in a.exits] for i in variables}
    sides_at = {xy: {e.side for i in ids if i in exits for e in exits[i] if not e.inner} for xy, ids in maps.items()}
    sizes = collections.Counter((v["width"], v["height"]) for v in variables.values())
    usual = sizes.most_common(1)[0][0] if sizes else None

    def reaches(xy: Coords, i: int) -> set[str]:
        """Sides on which the map has a sun facing a neighbour with a sun back."""
        return {e.side for e in exits[i] if not e.inner
                and OPPOSITE[e.side] in sides_at.get((xy[0] + SIDES[e.side][0], xy[1] + SIDES[e.side][1]), set())}

    shared = SharedCoords({}, {}, [])
    for xy, ids in maps.items():
        readable = [i for i in ids if i in variables]
        if len(readable) <= 1 and not (chosen and xy in chosen):
            shared.maps[xy] = ids
            continue
        main = chosen[xy] if chosen and xy in chosen else min(
            readable, key=lambda i: (-len(reaches(xy, i)), (variables[i]["width"], variables[i]["height"]) != usual, i))
        kept, covered = [main], reaches(xy, main)
        for i in readable:
            if i == main:
                continue
            if exits[i] and all(e.inner for e in exits[i]):
                shared.rooms.append(xy)
            elif reaches(xy, i) - covered:
                kept.append(i)
                covered |= reaches(xy, i)
        shared.maps[xy] = kept
        shared.main_areas[xy] = len(areas_of[main])
    return shared


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
    corners = {c: {uv for uv, n in collections.Counter(e.uv for part in parts for e in part.exits if not e.inner).items() if n > 1}
               for c, parts in areas.items()}
    passages, further = [], []
    for (x, y) in sorted(areas):
        for side in ("right", "bottom"):  # each neighbour pair once
            dx, dy = SIDES[side]
            other = (x + dx, y + dy)
            if other not in areas:
                continue
            back = "left" if side == "right" else "top"
            # A sun in a corner counts on two sides: one only on this edge comes first.
            here = sorted(((i, e) for i, part in enumerate(areas[(x, y)]) for e in part.exits if e.side == side),
                          key=lambda o: o[1].uv in corners[(x, y)])
            there = sorted(((j, e) for j, part in enumerate(areas[other]) for e in part.exits if e.side == back),
                           key=lambda o: o[1].uv in corners[other])
            connected = ((any(not e.inner for _, e in here) and there) or any(e.inner for _, e in here)
                         or (any(not e.inner for _, e in there) and here) or any(e.inner for _, e in there))
            if not connected:
                continue
            extra: list = []
            for (i, j), (t, ua, ub) in _pair_areas(here, there, corners[(x, y)] | corners[other], extra).items():
                passages.append(Passage(((x, y), i), (other, j), t, ua, ub))
            further += [Passage(((x, y), i), (other, j), t, ua, ub) for (i, j), (t, ua, ub) in extra]
    # A second sun between the same two areas, unless one of its suns
    # already leads elsewhere (a corner sun counts on two edges).
    used = {(p.a[0], p.ua) for p in passages} | {(p.b[0], p.ub) for p in passages}
    passages += [p for p in further if (p.a[0], p.ua) not in used and (p.b[0], p.ub) not in used]
    return _one_way(areas, passages + _unpaired_suns(areas, passages))


def _lands_in(areas: dict[Coords, list[Area]], src: Coords, uv, dst: Coords, part: int) -> bool:
    """Whether leaving src by the sun at uv lands in that part of dst. You
    arrive by the sun facing the one you left by, the closest along the
    edge; a split map is entered in that sun's part only."""
    for area in areas[src]:
        for e in area.exits:
            dx, dy = SIDES[e.side]
            if e.uv != uv or (src[0] + dx, src[1] + dy) != dst:
                continue
            if e.inner:
                return True
            facing = [(abs(f.t - e.t), j) for j, other in enumerate(areas[dst])
                      for f in other.exits if f.side == OPPOSITE[e.side] and not f.inner]
            return not facing or min(facing)[1] == part
    return True


def _one_way(areas: dict[Coords, list[Area]], passages: list[Passage]) -> list[Passage]:
    """Mark passages that only lead one way: from a map with one part to a
    part of a split map that its sun doesn't lead into, you can come back
    but not go."""
    out = []
    for p in passages:
        ab = _lands_in(areas, p.a[0], p.ua, p.b[0], p.b[1])
        ba = _lands_in(areas, p.b[0], p.ub, p.a[0], p.a[1])
        out.append(p if ab == ba else replace(p, oneway="ab" if ab else "ba"))
    return out


OPPOSITE = {"left": "right", "right": "left", "top": "bottom", "bottom": "top"}


def _unpaired_suns(areas: dict[Coords, list[Area]], passages: list[Passage]) -> list[Passage]:
    """Passages for suns no passage uses, towards a map already linked on
    that side: several suns of a map can lead to the same neighbour. Each
    leaves from its own part of the map and arrives at the closest sun on
    the facing edge there, an unused one if any."""
    linked = {frozenset((p.a[0], p.b[0])) for p in passages}
    used = {(p.a[0], p.ua) for p in passages} | {(p.b[0], p.ub) for p in passages}
    options = []
    for xy, parts in sorted(areas.items()):
        for i, area in enumerate(parts):
            for e in area.exits:
                dx, dy = SIDES[e.side]
                other = (xy[0] + dx, xy[1] + dy)
                if e.inner or (xy, e.uv) in used or frozenset((xy, other)) not in linked:
                    continue
                for j, part in enumerate(areas[other]):
                    for f in part.exits:
                        if f.side == OPPOSITE[e.side] and not f.inner:
                            options.append(((other, f.uv) in used, abs(e.t - f.t), xy, i, e, other, j, f))
    added = []
    for _, _, xy, i, e, other, j, f in sorted(options, key=lambda o: o[:2]):
        if (xy, e.uv) in used:
            continue  # paired already (a corner sun counts on two sides)
        used |= {(xy, e.uv), (other, f.uv)}
        t = round((e.t + f.t) / 2, 3)
        # Passages go from the left or top map, like the others.
        added.append(Passage((xy, i), (other, j), t, e.uv, f.uv) if e.side in ("right", "bottom")
                     else Passage((other, j), (xy, i), t, f.uv, e.uv))
    return added


def _pair_areas(here: list[tuple[int, Exit]], there: list[tuple[int, Exit]], corners: set = frozenset(),
                extra: list | None = None) -> dict[tuple[int, int], tuple[float, tuple | None, tuple | None]]:
    """Which area here connects to which area there: where they cross the
    edge, and the suns used on each side (`corners`: suns counting on two
    edges, paired last). Further sun pairs between the same two areas go
    to `extra`: two suns can lead to the same map."""
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
    split_here, split_there = len({i for i, _ in here}) > 1, len({j for j, _ in there}) > 1
    ladders = any(e.inner for _, e in here + there)
    if (not split_here and not split_there) or min(len(here), len(there)) == 1 or ladders:
        # One path, one sun on a side that every path shares, or a ladder
        # (not on the edge, so not paired by position): the first exits
        # (suns only on this edge come first).
        for i, a in here:
            for j, b in there:
                pairs.setdefault((i, j), (round((a.t + b.t) / 2, 3), a.uv, b.uv))
        return pairs
    # Pair exits by position along the edge, closest first, each exit once,
    # so that the paths to the parts of a split map use different suns.
    # Suns only on this edge first: a corner sun may lead the other way.
    used_here, used_there = set(), set()
    for _, distance, (k, (i, a)), (m, (j, b)) in sorted(
            ((a.uv in corners or b.uv in corners, abs(a.t - b.t), (k, (i, a)), (m, (j, b)))
             for k, (i, a) in enumerate(here) for m, (j, b) in enumerate(there)), key=lambda o: o[:2]):
        if k in used_here or m in used_there:
            continue
        used_here.add(k)
        used_there.add(m)
        if (i, j) in pairs:
            if extra is not None:
                extra.append(((i, j), (round((a.t + b.t) / 2, 3), a.uv, b.uv)))
            continue
        pairs[(i, j)] = (round((a.t + b.t) / 2, 3), a.uv, b.uv)
    if not (split_here and split_there):
        # One side isn't split: every part of the other side with an exit
        # reaches it, even with fewer suns than parts.
        for i, a in here:
            for j, b in there:
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


@dataclass(frozen=True)
class Entrance:
    """A way into the zone: a ladder or door, or a sun leading out of the zone."""
    coords: Coords
    area: int
    uv: tuple[float, float] | None
    kind: str  # "ladder" or "sun"
    towards: Coords  # where it leads: the same cell for a ladder, the neighbour for a sun


def find_entrances(areas: dict[Coords, list[Area]], passages: list[Passage]) -> list[Entrance]:
    """Exits leading out of the zone. A sun that also faces a connected map
    of the zone isn't one: a sun in a corner counts on two sides."""
    connected = {(p.a[0], p.b[0]) for p in passages} | {(p.b[0], p.a[0]) for p in passages}
    # Suns of the passages themselves, including ones between maps that aren't neighbours.
    used = {(p.a[0], p.ua) for p in passages if p.ua} | {(p.b[0], p.ub) for p in passages if p.ub}
    for (x, y), parts in areas.items():
        for area in parts:
            for e in area.exits:
                dx, dy = SIDES[e.side]
                if ((x, y), (x + dx, y + dy)) in connected:
                    used.add(((x, y), e.uv))
    found: dict[tuple, Entrance] = {}
    for (x, y), parts in areas.items():
        for i, area in enumerate(parts):
            for e in area.exits:
                dx, dy = SIDES[e.side]
                towards = (x + dx, y + dy)
                if towards in areas or ((x, y), e.uv) in used:
                    continue
                kind = "ladder" if e.inner else "sun"
                found.setdefault(((x, y), e.uv), Entrance((x, y), i, e.uv, kind, (x, y) if e.inner else towards))
    return sorted(found.values(), key=lambda e: (e.coords[1], e.coords[0], e.uv or ()))


def sun_on_side(areas: dict[Coords, list[Area]], coords: Coords, side: str) -> tuple[int, tuple[float, float] | None]:
    """The area and the sun of a map's only exit on one side (for passages added by hand)."""
    found = [(i, e.uv) for i, a in enumerate(areas.get(coords, [])) for e in a.exits
             if e.side == side and not e.inner]
    if len({uv for _, uv in found}) != 1:
        raise ValueError(f"[{coords[0]},{coords[1]}] has {len(found)} suns on its {side} side, expected one")
    return found[0]
