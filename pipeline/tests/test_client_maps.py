import struct
import zlib

from archimap.client_maps import (Area, Exit, find_entrances, map_areas, map_layout, passages_between, plain_map_file,
                                  read_cells, sun_links, swf_variables)

HASH = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
WALK, WALL, SUN = 4, 0, 2  # cell movement types


def cell(movement=WALK, layer2=0) -> str:
    """10-char cell: active (bit 32 of char 0), movement in bits 3-5 of char 2,
    layer-2 object in chars 8-9."""
    return HASH[32] + "a" + HASH[movement << 3] + "aaaa" + "a" + HASH[layer2 >> 6] + HASH[layer2 & 63]


def cell_id(x, y, width=15):
    """Inverse of the half-cell grid: x even on even rows, odd on odd rows."""
    return (y // 2) * (2 * width - 1) + (x // 2 if y % 2 == 0 else width + x // 2)


def map_data(cells_at: dict, width=15, height=17, default=WALK) -> str:
    n = width * height + (width - 1) * (height - 1)
    by_id = {cell_id(x, y, width): c for (x, y), c in cells_at.items()}
    return "".join(by_id.get(i, cell(default)) for i in range(n))


def map_swf(data: str, width=15, height=17) -> bytes:
    """Compressed SWF setting width, height and mapData like the client's map files."""
    pool = [b"width", b"height", b"mapData"]
    actions = b"\x88" + struct.pack("<H", 2 + sum(len(s) + 1 for s in pool)) + struct.pack("<H", 3) + b"".join(s + b"\0" for s in pool)
    for index, value in ((0, struct.pack("<i", width)), (1, struct.pack("<i", height))):
        push = bytes([8, index, 7]) + value
        actions += b"\x96" + struct.pack("<H", len(push)) + push + b"\x1d"
    push = bytes([8, 2, 0]) + data.encode() + b"\0"
    actions += b"\x96" + struct.pack("<H", len(push)) + push + b"\x1d\x00"
    tag = struct.pack("<H", (12 << 6) | 0x3F) + struct.pack("<I", len(actions)) + actions
    body = bytes([0x00]) + b"\x00\x0c\x01\x00" + tag + b"\x00\x00"  # empty RECT, rate, count, tag, end
    return b"CWS\x06" + struct.pack("<I", len(body) + 8) + zlib.compress(body)


def variables(cells_at: dict) -> dict:
    return {"width": 15, "height": 17, "mapData": map_data(cells_at)}


def test_reads_variables_and_cells(tmp_path):
    (tmp_path / "1_0001.swf").write_bytes(map_swf(map_data({(28, 16): cell(SUN)})))
    v = swf_variables(tmp_path / "1_0001.swf")
    assert (v["width"], v["height"]) == (15, 17) and len(v["mapData"]) == 479 * 10
    cells, cols, rows = read_cells(v)
    assert (cols, rows) == (28, 32)
    assert [p for p, (_, sun) in cells.items() if sun] == [(28, 16)]


def test_sun_graphic_marks_exits_too():
    cells, _, _ = read_cells(variables({(28, 16): cell(WALK, layer2=1030)}))
    assert [p for p, (_, sun) in cells.items() if sun] == [(28, 16)]


def test_plain_file_skips_encrypted_versions(tmp_path):
    (tmp_path / "5_0001.swf").write_bytes(b"x")
    (tmp_path / "5_0002X.swf").write_bytes(b"x")
    assert plain_map_file(tmp_path, 5).name == "5_0001.swf"
    assert plain_map_file(tmp_path, 6) is None


def test_a_wall_splits_a_map_into_areas():
    wall = {(x, y): cell(WALL) for x in (13, 14, 15) for y in range(33) if (x + y) % 2 == 0}
    suns = {(6, 32): cell(SUN), (22, 32): cell(SUN)}  # one exit at the bottom of each side
    areas = map_areas(variables({**wall, **suns}))
    assert len(areas) == 2
    assert sorted((e.side, e.t) for a in areas for e in a.exits) == [("bottom", 0.214), ("bottom", 0.786)]
    assert areas[0].center[0] < 0.5 < areas[1].center[0]


def test_inner_exits_of_a_closed_room():
    areas = map_areas(variables({(18, 22): cell(SUN), (16, 12): cell(SUN)}))
    assert sorted((e.side, e.inner) for e in areas[0].exits) == [("bottom", True), ("top", True)]


def test_unsplit_maps_connect_whatever_the_sun_positions():
    # Suns aren't mirrored between maps: leave mid-edge, the way back sits in a corner.
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("right", 0.4)])],
             (1, 0): [Area((0.5, 0.5), [Exit("left", 0.03)])],
             (0, 1): [Area((0.5, 0.5), [])]}  # no sun facing (0,0): a wall
    assert [(p.a, p.b) for p in passages_between(areas)] == [(((0, 0), 0), ((1, 0), 0))]


def test_split_maps_pair_their_parts_by_position():
    areas = {(0, 0): [Area((0.5, 0.2), [Exit("right", 0.2)]), Area((0.5, 0.8), [Exit("right", 0.8)])],
             (1, 0): [Area((0.5, 0.8), [Exit("left", 0.75)]), Area((0.5, 0.2), [Exit("left", 0.25)])]}
    assert [(p.a[1], p.b[1], p.t) for p in passages_between(areas)] == [(0, 1, 0.225), (1, 0, 0.775)]


def test_one_part_facing_two_gives_two_paths():
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("bottom", 0.3), Exit("bottom", 0.7)])],
             (0, 1): [Area((0.2, 0.5), [Exit("top", 0.3)]), Area((0.8, 0.5), [Exit("top", 0.7)])]}
    assert [(p.a[1], p.b[1]) for p in passages_between(areas)] == [(0, 0), (0, 1)]


def test_room_exit_is_enough_on_its_own():
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("bottom", 0.6, inner=True)])],
             (0, 1): [Area((0.5, 0.5), [Exit("left", 0.5)])]}
    assert [(p.a, p.b) for p in passages_between(areas)] == [(((0, 0), 0), ((0, 1), 0))]


def test_sun_links_from_files(tmp_path):
    (tmp_path / "1_0001.swf").write_bytes(map_swf(map_data({(28, 16): cell(SUN)})))  # exit right
    (tmp_path / "2_0001.swf").write_bytes(map_swf(map_data({(0, 16): cell(SUN)})))   # exit left
    links, unreadable = sun_links({(0, 0): [1], (1, 0): [2], (2, 0): [3]}, tmp_path)
    assert links == {((0, 0), (1, 0))} and unreadable == {(2, 0)}


def test_layout_packs_three_cells_per_character():
    v = variables({(0, 0): cell(WALL), (2, 0): cell(SUN)})  # cells 0 and 1; the rest floor
    layout = map_layout(v)
    assert (layout["w"], layout["h"], len(layout["cells"])) == (15, 17, 160)  # ceil(479 / 3)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    first = alphabet.index(layout["cells"][0])
    assert (first % 4, first // 4 % 4, first // 16) == (1, 3, 2)  # wall, sun, floor


def test_routes_follow_the_floor_around_a_wall():
    # A wall across the middle with a gap at the bottom: the route from the top-left
    # sun to the top-right sun must go down through the gap.
    wall = {(x, y): cell(WALL) for x in (13, 14, 15) for y in range(0, 25) if (x + y) % 2 == 0}
    suns = {(6, 0): cell(SUN), (22, 0): cell(SUN)}
    (area,) = map_areas(variables({**wall, **suns}))
    (route,) = area.paths
    assert route[0] in ((round(6 / 28, 3), 0.0), (round(22 / 28, 3), 0.0))
    assert max(v for _, v in route) > 24 / 32  # went below the wall


def test_single_exit_part_gets_a_dead_end_route():
    (area,) = map_areas(variables({(14, 0): cell(SUN)}))
    assert len(area.paths) == 1 and len(area.paths[0]) >= 2


def test_passages_record_the_suns_on_each_side():
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("right", 0.4, uv=(0.97, 0.4))])],
             (1, 0): [Area((0.5, 0.5), [Exit("left", 0.03, uv=(0.03, 0.03))])]}
    (p,) = passages_between(areas)
    assert (p.ua, p.ub) == ((0.97, 0.4), (0.03, 0.03))


def test_entrances_are_exits_leading_out_of_the_zone():
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("right", 0.5, uv=(0.97, 0.5)),
                                         Exit("top", 0.97, uv=(0.97, 0.03)),       # corner sun...
                                         Exit("right", 0.03, uv=(0.97, 0.03)),     # ...also on the right
                                         Exit("top", 0.5, inner=True, uv=(0.5, 0.4))])],  # ladder
             (1, 0): [Area((0.5, 0.5), [Exit("left", 0.03, uv=(0.03, 0.03))])]}
    passages = passages_between(areas)
    found = find_entrances(areas, passages)
    # The corner sun serves the passage to (1,0): not an entrance. The ladder is.
    assert [(e.coords, e.kind, e.towards) for e in found] == [((0, 0), "ladder", (0, 0))]


def test_a_sun_only_on_the_edge_is_preferred_to_a_corner_one():
    corner = (0.86, 0.06)  # top-right corner: counts on the top and the right
    areas = {(6, -14): [Area((0.5, 0.4), [Exit("top", 0.86, uv=corner), Exit("right", 0.06, uv=corner),
                                           Exit("right", 0.59, uv=(0.96, 0.59))])],
             (7, -14): [Area((0.3, 0.8), [Exit("left", 0.66, uv=(0.04, 0.66))])],
             (6, -15): [Area((0.5, 0.5), [Exit("bottom", 0.89, uv=(0.89, 0.97))])]}  # where the corner sun leads
    [p] = [p for p in passages_between(areas) if p.b[0] == (7, -14)]
    assert (p.ua, p.ub) == ((0.96, 0.59), (0.04, 0.66))


def test_paths_to_the_parts_of_a_split_map_use_different_suns():
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("right", 0.34, uv=(0.96, 0.34)), Exit("right", 0.53, uv=(0.96, 0.53))])],
             (1, 0): [Area((0.2, 0.3), [Exit("left", 0.3, uv=(0.04, 0.3))]),
                      Area((0.2, 0.7), [Exit("left", 0.6, uv=(0.04, 0.6))])]}
    passages = passages_between(areas)
    assert sorted((p.b[1], p.ua) for p in passages) == [(0, (0.96, 0.34)), (1, (0.96, 0.53))]


def test_corner_suns_are_paired_last():
    # Sanctuaire des Dragoeufs [-7,30] -> [-6,30], checked in game: the
    # middle sun leads to the middle one, the top-right part's corner sun to
    # the top one.
    areas = {(-7, 30): [Area((0.53, 0.53), [Exit("right", 0.594, uv=(0.964, 0.594)), Exit("right", 0.906, uv=(0.964, 0.906)),
                                             Exit("bottom", 0.964, uv=(0.964, 0.906))]),
                        Area((0.81, 0.09), [Exit("right", 0.094, uv=(0.964, 0.094)), Exit("top", 0.964, uv=(0.964, 0.094))])],
             (-6, 30): [Area((0.53, 0.47), [Exit("left", 0.156, uv=(0.036, 0.156)), Exit("left", 0.531, uv=(0.036, 0.531)),
                                             Exit("left", 0.844, uv=(0.036, 0.844))])]}
    passages = sorted((p.a[1], p.ua, p.ub) for p in passages_between(areas))
    # ...and the bottom-right corner sun to the bottom one: two suns to the same map.
    assert passages == [(0, (0.964, 0.594), (0.036, 0.531)), (0, (0.964, 0.906), (0.036, 0.844)),
                        (1, (0.964, 0.094), (0.036, 0.156))]


def test_every_sun_towards_a_linked_map_gets_a_passage():
    # Two suns of the same part lead to the same neighbour, which has two suns back.
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("right", 0.3, uv=(0.96, 0.3)), Exit("right", 0.7, uv=(0.96, 0.7))])],
             (1, 0): [Area((0.5, 0.5), [Exit("left", 0.25, uv=(0.04, 0.25)), Exit("left", 0.75, uv=(0.04, 0.75))])]}
    passages = sorted((p.ua, p.ub) for p in passages_between(areas))
    assert passages == [((0.96, 0.3), (0.04, 0.25)), ((0.96, 0.7), (0.04, 0.75))]


def test_a_sun_into_a_split_map_leads_to_one_part_only():
    # (0,0) has one sun to the right, by the top; (1,0) is split, a sun by the top and one by the bottom.
    areas = {(0, 0): [Area((0.5, 0.5), [Exit("right", 0.2, uv=(0.96, 0.2))])],
             (1, 0): [Area((0.2, 0.2), [Exit("left", 0.25, uv=(0.04, 0.25))]),
                      Area((0.2, 0.8), [Exit("left", 0.8, uv=(0.04, 0.8))])]}
    ways = sorted((p.b[1], p.oneway) for p in passages_between(areas))
    assert ways == [(0, None), (1, "ba")]  # the bottom part can be left, not entered
