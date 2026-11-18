"""Zones whose maps are stacked: several maps on the same coordinates.

In the Arbre Hakam, up to ten maps share one [x,y]: it's a spiral of
landings joined by stairs, and a stair leads to another map on the same
cell. The client doesn't say which map a sun leads to (the server knows),
so the landings and the stairs come from a walk through the zone (see
docs/arbre-hakam.md). A zone config with "stacked": true is built landing
by landing, each like an ordinary zone (suns, areas, layouts), and every
map keeps its id:

    {"name": "Arbre Hakam", "stacked": true,
     "parts": [{"client_subarea": 464, "part": "tronc"}, ...],
     "floors": [{"name": "Autour de l'arbre", "maps": [10816, 10817, ...]},
                {"maps": [11097, ...]},
                {"name": "Village de la Canopée", "maps": [11137, ...], "check": false},
                "rest"],
     "walked": [[10817, 11097], ...]}

Landings ("floors") are listed in climbing order, at most one map per cell
each. "rest" stands for the zone's maps not listed elsewhere, one landing
per id run (maps were made a landing at a time); without it they come last.
A landing may hold maps of another sub-area with nothing to check (the
village at the top). Entrances are the suns out of the zone on the first
landing, or on the landings listed as "entrance_floors" (indexes), only
those of the maps at "entrance_cells" when given; "entrances" adds ways in
by map id: {"map": 11170, "kind": "zaap", "label": "Village de la Canopée"}.
"remove_map_ids" leaves maps of the zone out, by id.

"walked" lists the map changes seen in the walk, by map id: between two
landings they are the stairs, inside one they join maps whose suns
didn't. A stair takes the sun of its map that no passage or entrance
uses (see _stair_sun), so routes and the map can show where it starts.
"""

from __future__ import annotations

from pathlib import Path

from .client_maps import SIDES, Exit, find_entrances, map_areas, read_layouts, sun_passages, zone_variables

Coords = tuple[int, int]
# A gap this large between map ids starts a new floor.
RUN_GAP = 3


def id_runs(ids, coords_of: dict[int, Coords]) -> list[list[int]]:
    """Runs of consecutive map ids, at most one map per cell each."""
    runs: list[list[int]] = []
    for i in sorted(ids):
        if runs and i - runs[-1][-1] <= RUN_GAP and coords_of[i] not in {coords_of[k] for k in runs[-1]}:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


def zone_floors(config: dict, zone_ids, coords_of: dict[int, Coords]) -> list[dict]:
    """The zone's floors, bottom first, as {"maps": [...], "name"?, "check"?}."""
    entries = config.get("floors", [])
    if "rest" not in entries:
        entries = [*entries, "rest"]
    listed = {i for e in entries if e != "rest" for i in e["maps"]}
    floors = []
    for entry in entries:
        if entry == "rest":
            floors += [{"maps": run} for run in id_runs(set(zone_ids) - listed, coords_of)]
        else:
            floors.append({**entry, "maps": sorted(entry["maps"])})
    for n, floor in enumerate(floors):
        cells = [coords_of[i] for i in floor["maps"]]
        if len(cells) != len(set(cells)):
            raise ValueError(f"floor {n + 1} has two maps on one cell")
    return [f for f in floors if f["maps"]]


def build_floors(floors: list[dict], coords_of: dict[int, Coords], maps_dir: Path | None,
                 walked: list[list[int]] = (), walked_suns: list = ()):
    """Maps, passages, links, stairs and entrances of every floor, for zone.json.

    Only suns leading out of the zone's cells are entrances: the others lead
    to another landing, which the walk tells (the stairs).
    """
    zone_cells: dict[Coords, list[int]] = {}
    for n, floor in enumerate(floors):
        for i in floor["maps"]:
            zone_cells.setdefault(coords_of[i], []).append(n)
    maps, passages, links, entrances, unreadable_count = [], [], [], [], 0
    floor_of = {i: n for n, floor in enumerate(floors) for i in floor["maps"]}
    # Each map's suns (with their area), and the ones passages or entrances use.
    exits: dict[int, list[tuple[int, Exit]]] = {}
    used: dict[int, set] = {}
    for n, floor in enumerate(floors):
        by_coords = {coords_of[i]: [i] for i in floor["maps"]}
        areas, found, unreadable = sun_passages(by_coords, maps_dir) if maps_dir else ({}, [], set(by_coords))
        layouts = read_layouts(by_coords, maps_dir) if maps_dir else {}
        unreadable_count += len(unreadable)
        for i in floor["maps"]:
            xy = coords_of[i]
            m = {"x": xy[0], "y": xy[1], "id": i, "floor": n, "source": "client"}
            if areas.get(xy):
                m["areas"] = [list(a.center) for a in areas[xy]]
                m["paths"] = [[list(p) for p in route] for a in areas[xy] for route in a.paths]
            if xy in layouts:
                m["layout"] = layouts[xy]
            maps.append(m)
        for p in found:
            passages.append({"a": [*p.a[0], p.a[1]], "b": [*p.b[0], p.b[1]], "t": p.t, "floor": n,
                             **({"ua": list(p.ua)} if p.ua else {}), **({"ub": list(p.ub)} if p.ub else {}),
                             **({"oneway": p.oneway} if p.oneway else {})})
        suns = sorted({(p.a[0], p.b[0]) for p in found})
        # Maps without a readable file: joined to their neighbours on the floor.
        guessed = {tuple(sorted((a, b))) for a in unreadable for b in by_coords
                   if abs(a[0] - b[0]) + abs(a[1] - b[1]) == 1}
        links += [[*a, *b, n] for a, b in sorted(set(suns) | guessed)]
        outside = [e for e in find_entrances(areas, found) if not [f for f in zone_cells.get(e.towards, []) if f != n]]
        entrances += [(n, e) for e in outside]
        id_at = {coords_of[i]: i for i in floor["maps"]}
        for xy, parts in areas.items():
            exits[id_at[xy]] = [(k, e) for k, a in enumerate(parts) for e in a.exits]
            used[id_at[xy]] = {p.ua for p in found if p.a[0] == xy} | {p.ub for p in found if p.b[0] == xy}
    # The walk: stairs between landings, and links the suns missed inside one.
    stairs = []
    linked = {(tuple(l[:2]), tuple(l[2:4]), l[4]) for l in links}
    for a, b in walked:
        if a not in floor_of or b not in floor_of:
            continue
        if floor_of[a] != floor_of[b]:
            stairs.append([a, b])
            continue
        ends = sorted((coords_of[a], coords_of[b]))
        if (ends[0], ends[1], floor_of[a]) not in linked:
            links.append([*ends[0], *ends[1], floor_of[a]])
    id_at = {(coords_of[i], floor_of[i]): i for i in floor_of}
    # Suns seen used in the recording: {(map, other map): sun uv}.
    read = {(h, t): tuple(uv) for h, t, uv in walked_suns if h in floor_of and t in floor_of}
    _follow_recording(read, passages, exits, used, lambda end, n: id_at[(tuple(end[:2]), n)], floor_of, coords_of)
    suns = _stair_suns(stairs, coords_of, floor_of, exits, used, read)
    released = _release_doubled(suns, exits, used, passages, lambda end, n: id_at[(tuple(end[:2]), n)])
    dropped = released.pop("dropped")
    passages[:] = [p for k, p in enumerate(passages) if k not in dropped]
    extra = _more_stair_suns(suns, exits, used, read, {i: coords_of[i] for i in floor_of})
    for key, more in released.items():
        extra[key] = more + [ke for ke in extra.get(key, []) if ke not in more]
    # Paths inside a map join a stair's suns once: they lead to the same landing.
    # The one they reach is the stair's first sun, the one routes take.
    if maps_dir and extra:
        variables = zone_variables(maps_dir, {here for here, _ in extra})
        for (here, there), more in extra.items():
            group = [suns[(here, there)], *more]
            areas = map_areas(variables[here], [{e.uv for _, e in group}])
            m = next(m for m in maps if m["id"] == here)
            m["paths"] = [[list(p) for p in route] for area in areas for route in area.paths]
            ends = {tuple(route[i]) for route in m["paths"] for i in (0, -1)}
            group.sort(key=lambda ke: min(((ke[1].uv[0] - u) ** 2 + (ke[1].uv[1] - v) ** 2 for u, v in ends), default=0))
            suns[(here, there)], extra[(here, there)] = group[0], group[1:]
    out = []
    for a, b in stairs:
        sb = suns.get((b, a))
        for sa in [suns.get((a, b)), *extra.get((a, b), [])]:
            out.append({"a": [a, sa[0] if sa else 0], "b": [b, sb[0] if sb else 0],
                        **({"ua": list(sa[1].uv)} if sa else {}), **({"ub": list(sb[1].uv)} if sb else {})})
        for sb2 in extra.get((b, a), []):
            sa = suns.get((a, b))
            out.append({"a": [a, sa[0] if sa else 0], "b": [b, sb2[0]],
                        **({"ua": list(sa[1].uv)} if sa else {}), "ub": list(sb2[1].uv)})
    stairs = out
    return maps, passages, sorted(links, key=lambda l: (l[4], l[:4])), stairs, entrances, unreadable_count


def _follow_recording(read, passages, exits, used, id_of, floor_of, coords_of) -> None:
    """Passages inside a landing as seen in the recording: between two maps
    whose move was read, only the passages using the suns read are kept (one
    is made from them when none does). A sun read for a stair isn't a
    passage. Changes `passages` and `used`."""
    def ids(p):
        return id_of(p["a"], p["floor"]), id_of(p["b"], p["floor"])
    exit_at = {i: {e.uv: (k, e) for k, e in ex} for i, ex in exits.items()}
    keep = []
    made = []
    for (a, b), uv in read.items():
        if floor_of[a] != floor_of[b] or a > b and (b, a) in read:
            continue
        ua, ub = read.get((a, b)), read.get((b, a))
        between = [p for p in passages if set(ids(p)) == {a, b}]

        def fits(p):
            mine = {ids(p)[0]: tuple(p.get("ua") or ()), ids(p)[1]: tuple(p.get("ub") or ())}
            return (ua is None or mine[a] == ua) and (ub is None or mine[b] == ub)
        good = [p for p in between if fits(p)]
        if not good and ua in exit_at.get(a, {}) and (ub is None or ub in exit_at.get(b, {})):
            other = between[0] if between else None
            if ub is None and other:
                ub = tuple(other["ub"] if ids(other)[1] == b else other["ua"])
            # Without a sun on the other map (none faces it), the passage ends in its middle.
            (ka, ea), kb = exit_at[a][ua], exit_at[b][ub][0] if ub in exit_at.get(b, {}) else 0
            made.append({"a": [*coords_of[a], ka], "b": [*coords_of[b], kb], "t": ea.t, "floor": floor_of[a],
                         "ua": list(ua), **({"ub": list(ub)} if ub in exit_at.get(b, {}) else {})})
        keep.append((a, b, good))
    drop = set()
    for a, b, good in keep:
        drop |= {id(p) for p in passages if set(ids(p)) == {a, b} and all(p is not g for g in good)}
    # Suns read for stairs: not passages.
    stair_suns = {(h, uv) for (h, t), uv in read.items() if floor_of[h] != floor_of[t]}
    for p in passages:
        a, b = ids(p)
        if (a, tuple(p.get("ua") or ())) in stair_suns or (b, tuple(p.get("ub") or ())) in stair_suns:
            drop.add(id(p))
    passages[:] = [p for p in passages if id(p) not in drop] + [m for m in made if not
                   (id_of(m["a"], m["floor"]), tuple(m["ua"])) in stair_suns]
    for i in used:
        used[i] = set()
    for p in passages:
        a, b = ids(p)
        if p.get("ua"):
            used.setdefault(a, set()).add(tuple(p["ua"]))
        if p.get("ub"):
            used.setdefault(b, set()).add(tuple(p["ub"]))


def _release_doubled(suns, exits, used, passages, id_of) -> dict:
    """Stairs with no sun of their own, on maps where several suns are
    passages to the same sun of one neighbour: all but one of those are the
    stair. Of two, the passage keeps the sun best in line with its
    neighbour's; of more, the one apart from the others (the rest look alike:
    one staircase). Changes `suns` and `used`; returns the stair's other
    suns, as {(map, other map): [(area, sun)]}, and under "dropped" the
    indexes of the passages that were stairs."""
    out: dict = {"dropped": set()}
    for (here, there), (_, sun) in list(suns.items()):
        if sun.uv not in used.get(here, set()):
            continue  # it has a sun of its own
        # Suns of this map, by the neighbour's sun they're a passage to.
        to: dict = {}
        for k, p in enumerate(passages):
            ends = ((p["a"], p.get("ua"), p["b"], p.get("ub")), (p["b"], p.get("ub"), p["a"], p.get("ua")))
            for mine, uv, theirs, their_uv in ends:
                if id_of(mine, p["floor"]) == here and uv and their_uv:
                    to.setdefault((id_of(theirs, p["floor"]), tuple(their_uv)), []).append((tuple(uv), k))
        doubled = [(key, g) for key, g in to.items() if len(g) > 1]
        if not doubled:
            continue
        (_, (tu, tv)), group = max(doubled, key=lambda kg: len(kg[1]))
        if len(group) == 2:
            # In line: the same place along the edge, mirrored across it.
            keep = min(group, key=lambda g: min(abs(g[0][0] - tu), abs(g[0][1] - tv)))
        else:
            keep = max(group, key=lambda g: min(abs(g[0][0] - o[0][0]) + abs(g[0][1] - o[0][1]) for o in group if o != g))
        stair = [g for g in group if g != keep]
        exit_at = {e.uv: (k, e) for k, e in exits[here]}
        found = [exit_at[uv] for uv, _ in stair if uv in exit_at]
        if not found:
            continue
        used[here] -= {uv for uv, _ in stair}
        out["dropped"] |= {k for _, k in stair}
        suns[(here, there)], out[(here, there)] = found[0], found[1:]
    return out


_FACING = {"left": (-1, 0), "right": (1, 0), "top": (0, -1), "bottom": (0, 1)}


def _more_stair_suns(suns, exits, used, read=None, coords_of=None) -> dict[tuple[int, int], list[tuple[int, Exit]]]:
    """Suns left over on a map whose stairs all lead to one map, on the same
    side of the map as the stair's sun: they lead there too (two ways up the
    same stair), as {(map, other map): [(area, sun)]}. Suns read in the
    recording for another move don't, nor suns on an edge facing a cell
    outside the zone (`coords_of` its maps): those are ways out."""
    read = read or {}
    cells = set((coords_of or {}).values())

    def way_out(here, e):
        if not cells or e.inner:
            return False
        (x, y), (dx, dy) = coords_of[here], _FACING[e.side]
        return (x + dx, y + dy) not in cells
    out = {}
    for here in {h for h, _ in suns}:
        dests = {there for h, there in suns if h == here}
        if len(dests) != 1:
            continue
        there = dests.pop()
        main = suns[(here, there)][1].uv
        taken = {main} | used.get(here, set()) | {uv for (h, t), uv in read.items() if h == here and t != there}
        # Same side: from the middle of the map, not opposite directions.
        alike = lambda uv: (uv[0] - 0.5) * (main[0] - 0.5) + (uv[1] - 0.5) * (main[1] - 0.5) > 0
        left = [(k, e) for k, e in exits.get(here, []) if e.uv not in taken and alike(e.uv) and not way_out(here, e)]
        if left:
            out[(here, there)] = left
    return out


def _stair_suns(stairs, coords_of, floor_of, exits, used, read=None) -> dict[tuple[int, int], tuple[int, Exit]]:
    """The sun each stair leaves its map by, as {(map, other map): (area, sun)}.

    A stair takes one of its map's suns that no passage uses, a different
    one per stair: on the edge facing the other map when it's on a
    neighbouring cell, else preferably a sun inside the map (a ladder, a
    staircase). Stairs to higher landings take the higher suns on screen.
    Maps with no sun left take the one nearest to the stair's other end.
    """
    out = {}
    from_map: dict[int, list[int]] = {}
    for a, b in stairs:
        from_map.setdefault(a, []).append(b)
        from_map.setdefault(b, []).append(a)
    read = read or {}
    for here, theres in from_map.items():
        # Suns read in the recording come first, and aren't free for the others.
        for there in theres:
            seen = [ke for ke in exits.get(here, []) if ke[1].uv == read.get((here, there))]
            if seen:
                out[(here, there)] = seen[0]
        taken = {out[(here, t)][1].uv for t in theres if (here, t) in out}
        read_here = {uv for (h, _), uv in read.items() if h == here}
        theres = [t for t in theres if (here, t) not in out]
        free = sorted(((k, e) for k, e in exits.get(here, []) if e.uv not in used.get(here, set()) | taken | read_here),
                      key=lambda ke: ke[1].uv[1])
        x, y = coords_of[here]
        for there in sorted(theres, key=lambda m: -floor_of[m]):
            tx, ty = coords_of[there]

            def fits(e: Exit) -> int:
                if (x, y) != (tx, ty):
                    return 2 * (not e.inner and SIDES[e.side] == (tx - x, ty - y))
                return int(e.inner)
            if free:
                best = max(free, key=lambda ke: fits(ke[1]))  # the highest on screen among the best
                out[(here, there)] = best
                free.remove(best)
    # Maps with no sun left: the sun nearest to where the stair ends on the
    # other map (it only places the stair: the route is the same).
    for here, theres in from_map.items():
        for there in theres:
            if (here, there) in out or not exits.get(here):
                continue
            u, v = out[(there, here)][1].uv if (there, here) in out else (0.5, 0.5)
            out[(here, there)] = min(exits[here], key=lambda ke: (ke[1].uv[0] - u) ** 2 + (ke[1].uv[1] - v) ** 2)
    return out
