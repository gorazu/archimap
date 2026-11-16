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
from collections.abc import Iterable
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


def trigger_cells(variables: dict[str, object]) -> tuple[list[tuple[int, int]], int, int]:
    """Positions of the map-change cells, and the grid size, in half-cell units.

    Cells come in rows of `width` then `width - 1` cells, offset by half a
    cell: x runs 0..2*width-2 across the screen, y 0..2*height-2 down it.
    """
    width, height = int(variables["width"]), int(variables["height"])
    data = str(variables["mapData"])
    triggers = []
    for cell_id, k in enumerate(range(0, len(data) - 9, 10)):
        c = [_HASH[ch] for ch in data[k:k + 10]]
        active, movement = (c[0] & 32) >> 5, (c[2] & 56) >> 3
        layer1 = ((c[0] & 4) << 11) + ((c[4] & 1) << 12) + (c[5] << 6) + c[6]
        layer2 = ((c[0] & 2) << 12) + ((c[7] & 1) << 12) + (c[8] << 6) + c[9]
        if (active and movement == TRIGGER_MOVEMENT) or SUN_GRAPHIC in (layer1, layer2):
            pair, rest = divmod(cell_id, 2 * width - 1)
            triggers.append((rest * 2, pair * 2) if rest < width else ((rest - width) * 2 + 1, pair * 2 + 1))
    return triggers, 2 * width - 2, 2 * height - 2


def map_exits(triggers: Iterable[tuple[int, int]], cols: int, rows: int) -> tuple[set[str], set[str]]:
    """Sides with a map change: (on the edge, from inside a closed room)."""
    edge, inner = set(), set()
    for x, y in triggers:
        near = {side for side, ok in (("left", x <= EDGE_MARGIN), ("right", x >= cols - EDGE_MARGIN),
                                      ("top", y <= EDGE_MARGIN), ("bottom", y >= rows - EDGE_MARGIN)) if ok}
        if near:
            edge |= near
        else:
            dx, dy = x - cols / 2, y - rows / 2
            inner.add(("right" if dx > 0 else "left") if abs(dx) > abs(dy) else ("bottom" if dy > 0 else "top"))
    return edge, inner


def links_between(exits: dict[Coords, tuple[set[str], set[str]]]) -> set[Link]:
    """Passages between neighbouring maps from their exits.

    An edge exit needs a matching exit on the other map (both sides of the
    passage have suns); a room's inner exit is enough on its own.
    """
    links = set()
    for (x, y), (edge, inner) in exits.items():
        for side, (dx, dy) in SIDES.items():
            other = (x + dx, y + dy)
            if other not in exits:
                continue
            back = next(s for s, d in SIDES.items() if d == (-dx, -dy))
            if (side in edge and back in exits[other][0] | exits[other][1]) or side in inner:
                links.add(tuple(sorted(((x, y), other))))
    return links


def sun_links(maps: dict[Coords, list[int]], maps_dir: Path) -> tuple[set[Link], set[Coords]]:
    """Passages from the map files; also returns the maps that had no readable file."""
    exits: dict[Coords, tuple[set[str], set[str]]] = {}
    unreadable = set()
    for coords, map_ids in maps.items():
        edge: set[str] = set()
        inner: set[str] = set()
        files = [plain_map_file(maps_dir, i) for i in map_ids]
        if not any(files):
            unreadable.add(coords)
            continue
        for path in filter(None, files):
            e, n = map_exits(*trigger_cells(swf_variables(path)))
            edge |= e
            inner |= n
        exits[coords] = (edge, inner)
    return links_between(exits), unreadable
