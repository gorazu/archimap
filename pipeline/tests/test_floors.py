import pytest
from test_client_zones import write_sol

from archimap.client_zones import build_zone, load_client_data
from archimap.floors import id_runs, zone_floors

COORDS = {1: (0, 0), 2: (1, 0), 3: (0, 0), 4: (1, 0), 9: (0, 0), 20: (1, 0)}


def test_id_runs_hold_one_map_per_cell():
    assert id_runs(COORDS, COORDS) == [[1, 2], [3, 4], [9], [20]]


def test_listed_floors_come_first_then_the_rest_in_place():
    config = {"floors": [{"maps": [3, 4]}, "rest", {"name": "Village", "maps": [20], "check": False}]}
    assert zone_floors(config, [1, 2, 3, 4, 9], COORDS) == [
        {"maps": [3, 4]}, {"maps": [1, 2]}, {"maps": [9]}, {"name": "Village", "maps": [20], "check": False}]
    # Without "rest", the other maps' runs come last.
    assert zone_floors({"floors": [{"maps": [9]}]}, [1, 2, 9], COORDS) == [{"maps": [9]}, {"maps": [1, 2]}]


def test_a_floor_cannot_stack_two_maps():
    with pytest.raises(ValueError, match="floor 1"):
        zone_floors({"floors": [{"maps": [1, 3]}]}, [1, 3], COORDS)


def test_stacked_zone_keeps_every_map_with_its_floor(tmp_path):
    maps = {"1": (0, 0, 7), "2": (1, 0, 7), "3": (0, 0, 7), "4": (1, 0, 8), "5": (5, 5, 8)}
    write_sol(tmp_path / "ANKXTRASO_1_MA.sol", {"_Data": {"MA": {
        "m": {k: {"x": x, "y": y, "sa": sa} for k, (x, y, sa) in maps.items()},
        "sa": {"7": {"n": "Tronc", "a": 1}, "8": {"n": "Village", "a": 1}},
        "a": {"1": {"n": "Ile"}},
    }}})
    client = load_client_data(tmp_path / "ANKXTRASO_1_MA.sol")
    config = {"name": "Arbre", "stacked": True, "parts": [{"client_subarea": 7, "part": "tronc"}],
              "floors": [{"maps": [3]}, "rest", {"name": "Village", "maps": [4], "check": False}],
              "walked": [[3, 1], [2, 4], [1, 2]]}
    zone, notes = build_zone("arbre", config, client, None, tmp_path / "arbre.json")
    assert [(m["id"], m["floor"], m["x"], m["y"], m["subarea"]) for m in zone["maps"]] == [
        (3, 0, 0, 0, "Tronc"), (1, 1, 0, 0, "Tronc"), (2, 1, 1, 0, "Tronc"), (4, 2, 1, 0, "Village")]
    assert zone["floors"] == [{"maps": 1}, {"maps": 2}, {"name": "Village", "check": False, "maps": 1}]
    assert zone["subareas"] == ["Tronc"]
    # Without map files, a floor's maps are joined to their neighbours.
    assert zone["links"] == [[0, 0, 1, 0, 1]]
    # Map changes walked between landings are the stairs.
    # Without map files, they have no sun to start from.
    assert zone["stairs"] == [{"a": [3, 0], "b": [1, 0]}, {"a": [2, 0], "b": [4, 0]}]
    assert notes[0] == "4 maps on 3 landings (3 to check)"
    config["remove_map_ids"] = [2]
    zone, _ = build_zone("arbre", config, client, None, tmp_path / "arbre.json")
    assert [m["id"] for m in zone["maps"]] == [3, 1, 4]


def test_each_stair_takes_a_free_sun_of_its_map():
    from archimap.client_maps import Exit
    from archimap.floors import _stair_suns
    coords = {1: (0, 0), 2: (0, 0), 3: (0, 0), 4: (1, 0)}
    floor_of = {1: 1, 2: 0, 3: 2, 4: 2}
    top, low, inner, edge = (Exit("top", 0.5, uv=(0.5, 0.1)), Exit("bottom", 0.5, uv=(0.5, 0.9)),
                             Exit("left", 0.5, True, uv=(0.3, 0.5)), Exit("right", 0.5, uv=(0.96, 0.5)))
    exits = {1: [(0, top), (0, low), (0, edge)]}
    # The right edge sun is a passage on map 1's own landing.
    suns = _stair_suns([[1, 2], [1, 3], [1, 4]], coords, floor_of, exits, {1: {edge.uv}})
    # The stair to the next cell has no sun facing it left; up and down take the higher and lower suns.
    assert suns[(1, 3)][1] == top and suns[(1, 4)][1] == low
    # No sun left for the last one: the nearest to the other end (the middle of the map when unknown).
    assert suns[(1, 2)][1] == top
    exits = {1: [(0, top), (1, inner), (0, edge)]}
    suns = _stair_suns([[1, 2], [1, 4]], coords, floor_of, exits, {})
    # A neighbouring cell: the edge facing it; the same cell: a sun inside the map.
    assert suns[(1, 4)][1] == edge and suns[(1, 2)][1] == inner


def test_leftover_suns_join_the_only_stair_of_their_map():
    from archimap.client_maps import Exit
    from archimap.floors import _more_stair_suns
    up, side, passage = (Exit("top", 0.5, uv=(0.5, 0.1)), Exit("left", 0.5, True, uv=(0.3, 0.4)),
                         Exit("right", 0.5, uv=(0.96, 0.5)))
    exits = {1: [(0, up), (0, side), (0, passage)], 2: [(0, up), (0, side)]}
    suns = {(1, 5): (0, up), (2, 5): (0, up), (2, 6): (0, side)}
    # Map 1's other free sun leads to map 5 too; map 2 has two stairs, so its suns stay apart.
    assert _more_stair_suns(suns, exits, {1: {passage.uv}}) == {(1, 5): [(0, side)]}
    # A sun on an edge facing no map of the zone is a way out (the start map's sun to the Jungle obscure).
    way_out = Exit("left", 0.4, uv=(0.04, 0.4))
    exits[1].append((0, way_out))
    assert _more_stair_suns(suns, exits, {1: {passage.uv}}) == {(1, 5): [(0, side), (0, way_out)]}
    assert _more_stair_suns(suns, exits, {1: {passage.uv}}, coords_of={1: (0, 0), 5: (0, 0)}) == {(1, 5): [(0, side)]}


def test_paths_reach_one_sun_of_a_group():
    from archimap.client_maps import _area_paths
    part = {(x, 0) for x in range(9)}
    # Exits at both ends and in the middle: the two ends lead to the same place.
    assert len(_area_paths(part, [(4, 0), (0, 0), (8, 0)], 8, 2)) == 2
    assert len(_area_paths(part, [(4, 0), (0, 0), (8, 0)], 8, 2, [[(0, 0), (8, 0)]])) == 1


def test_suns_doubled_on_one_passage_are_the_stair_when_it_has_none():
    from archimap.client_maps import Exit
    from archimap.floors import _release_doubled
    left, middle, right = (Exit("bottom", 0.1, uv=(0.1, 0.97)), Exit("bottom", 0.4, uv=(0.4, 0.97)),
                           Exit("bottom", 0.8, uv=(0.8, 0.97)))
    exits = {1: [(0, left), (0, middle), (0, right)]}
    # Three suns of map 1 are passages to the same sun of map 2 below; the stair got one of them anyway.
    passages = [{"a": [0, 0, 0], "b": [0, 1, 0], "ua": list(e.uv), "ub": [0.25, 0.03], "floor": 0} for e in (left, middle, right)]
    suns = {(1, 3): (0, left)}
    used = {1: {left.uv, middle.uv, right.uv}}
    out = _release_doubled(suns, exits, used, passages, lambda end, n: {(0, 0): 1, (0, 1): 2}[tuple(end[:2])])
    # The two alike are the stair, the one apart stays the passage.
    assert {suns[(1, 3)][1], *(e for _, e in out[(1, 3)])} == {left, middle}
    assert out["dropped"] == {0, 1} and used[1] == {right.uv}


def test_passages_follow_the_suns_seen_in_the_recording():
    from archimap.client_maps import Exit
    from archimap.floors import _follow_recording
    a1, a2, b1 = Exit("bottom", 0.2, uv=(0.2, 0.97)), Exit("bottom", 0.7, uv=(0.7, 0.97)), Exit("top", 0.5, uv=(0.5, 0.03))
    exits = {1: [(0, a1), (0, a2)], 2: [(0, b1)]}
    coords = {1: (0, 0), 2: (0, 1)}
    id_of = lambda end, n: {(0, 0): 1, (0, 1): 2}[tuple(end[:2])]
    passages = [{"a": [0, 0, 0], "b": [0, 1, 0], "t": 0.2, "floor": 0, "ua": [0.2, 0.97], "ub": [0.5, 0.03]}]
    used = {1: {a1.uv}, 2: {b1.uv}}
    # The player left map 1 by its other bottom sun: the passage takes it.
    _follow_recording({(1, 2): a2.uv}, passages, exits, used, id_of, {1: 0, 2: 0}, coords)
    assert [(p["ua"], p["ub"]) for p in passages] == [([0.7, 0.97], [0.5, 0.03])]
    assert used == {1: {a2.uv}, 2: {b1.uv}}
