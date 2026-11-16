import struct
import zlib

from archimap.client_maps import links_between, map_exits, plain_map_file, sun_links, swf_variables, trigger_cells

HASH = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"


def cell(trigger=False) -> str:
    """10-char cell: active (bit 32 of char 0), movement in bits 3-5 of char 2."""
    movement = 2 if trigger else 4
    return HASH[32] + "a" + HASH[movement << 3] + "aaaaaaa"


def map_swf(width, height, trigger_ids) -> bytes:
    """Compressed SWF setting width, height and mapData like the client's map files."""
    n = width * height + (width - 1) * (height - 1)
    data = "".join(cell(i in trigger_ids) for i in range(n))
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


def cell_id(x, y, width=15):
    """Inverse of the half-cell grid: x even on even rows, odd on odd rows."""
    pair = y // 2
    return pair * (2 * width - 1) + (x // 2 if y % 2 == 0 else width + x // 2)


def test_reads_variables_and_trigger_positions(tmp_path):
    right_edge = cell_id(28, 16)
    (tmp_path / "1_0001.swf").write_bytes(map_swf(15, 17, {right_edge}))
    variables = swf_variables(tmp_path / "1_0001.swf")
    assert (variables["width"], variables["height"]) == (15, 17)
    assert len(variables["mapData"]) == 479 * 10
    triggers, cols, rows = trigger_cells(variables)
    assert triggers == [(28, 16)] and (cols, rows) == (28, 32)


def test_plain_file_skips_encrypted_versions(tmp_path):
    (tmp_path / "5_0001.swf").write_bytes(b"x")
    (tmp_path / "5_0002X.swf").write_bytes(b"x")
    assert plain_map_file(tmp_path, 5).name == "5_0001.swf"
    assert plain_map_file(tmp_path, 6) is None


def test_exits_from_edges_and_from_rooms():
    assert map_exits([(28, 16), (1, 30)], 28, 32) == ({"right", "left", "bottom"}, set())
    assert map_exits([(18, 22), (16, 12)], 28, 32) == (set(), {"bottom", "top"})  # ladder room


def test_edge_passages_need_suns_on_both_sides_rooms_dont():
    exits = {
        (0, 0): ({"right"}, set()),
        (1, 0): ({"left", "bottom"}, set()),
        (1, 1): (set(), set()),            # no sun facing up: (1,0)-(1,1) is a wall
        (0, 1): (set(), {"top"}),          # room whose ladder leads up to (0,0)
    }
    assert links_between(exits) == {((0, 0), (1, 0)), ((0, 0), (0, 1))}


def test_sun_links_from_files(tmp_path):
    (tmp_path / "1_0001.swf").write_bytes(map_swf(15, 17, {cell_id(28, 16)}))  # exit right
    (tmp_path / "2_0001.swf").write_bytes(map_swf(15, 17, {cell_id(0, 16)}))   # exit left
    links, unreadable = sun_links({(0, 0): [1], (1, 0): [2], (2, 0): [3]}, tmp_path)
    assert links == {((0, 0), (1, 0))} and unreadable == {(2, 0)}


def test_sun_graphic_marks_exits_too(tmp_path):
    # Layer-2 object id 1030 = (c8 << 6) + c9 with c8 = 16, c9 = 6.
    sun = HASH[32] + "a" + HASH[4 << 3] + "aaaa" + "a" + HASH[16] + HASH[6]
    width, height = 15, 17
    n = width * height + (width - 1) * (height - 1)
    target = cell_id(28, 16)
    data = "".join(sun if i == target else cell() for i in range(n))
    triggers, _, _ = trigger_cells({"width": width, "height": height, "mapData": data})
    assert triggers == [(28, 16)]
