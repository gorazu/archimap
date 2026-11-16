import json
import struct

from archimap.client_zones import build_zone, load_client_data
from archimap.sol import read_sol


def amf(value) -> bytes:
    """Tiny AMF0 writer (numbers, strings, objects) to fake client data."""
    if isinstance(value, (int, float)):
        return b"\x00" + struct.pack(">d", value)
    if isinstance(value, str):
        raw = value.encode()
        return b"\x02" + struct.pack(">H", len(raw)) + raw
    body = b"".join(struct.pack(">H", len(k.encode())) + k.encode() + amf(v) for k, v in value.items())
    return b"\x03" + body + b"\x00\x00\x09"


def write_sol(path, data: dict) -> None:
    name = b"ANKXTRASO_1_MA"
    body = struct.pack(">H", len(name)) + name + b"\x00\x00\x00\x00"
    for key, value in data.items():
        body += struct.pack(">H", len(key.encode())) + key.encode() + amf(value) + b"\x00"
    path.write_bytes(b"\x00\xbf" + struct.pack(">I", len(body) + 6) + b"TCSO\x00\x04\x00\x00\x00\x00" + body)


def fake_client(tmp_path):
    maps = {"1": (0, 0, 7), "2": (1, 0, 7), "3": (1, 1, 7), "4": (1, 1, 7), "5": (9, 9, 8)}
    write_sol(tmp_path / "ANKXTRASO_1_MA.sol", {"_Data": {"MA": {
        "m": {k: {"x": x, "y": y, "sa": sa} for k, (x, y, sa) in maps.items()},
        "sa": {"7": {"n": "Egout de Test", "a": 1}, "8": {"n": "Ailleurs", "a": 1}},
        "a": {"1": {"n": "Testville"}},
        "sua": {},
    }}})
    return load_client_data(tmp_path / "ANKXTRASO_1_MA.sol")


def test_sol_reader_round_trip(tmp_path):
    write_sol(tmp_path / "x.sol", {"_Data": {"a": 1.5, "b": "é", "c": {"d": -2}}})
    assert read_sol(tmp_path / "x.sol") == {"_Data": {"a": 1.5, "b": "é", "c": {"d": -2.0}}}


def test_load_client_data_groups_maps_by_subarea(tmp_path):
    client = fake_client(tmp_path)
    assert client.subareas[7] == ("Egout de Test", "Testville")
    assert sorted(client.maps[7]) == [(1, (0, 0)), (2, (1, 0)), (3, (1, 1)), (4, (1, 1))]


def test_zone_from_client_joins_neighbours_and_applies_corrections(tmp_path):
    client = fake_client(tmp_path)
    config_path = tmp_path / "egout.json"
    config = {"client_subarea": 7, "name": "Égout de test", "remove_links": [[0, 0, 1, 0]]}
    config_path.write_text(json.dumps(config))
    zone, notes = build_zone("egout", config, client, None, config_path)
    assert zone["name"] == "Égout de test"
    assert [(m["x"], m["y"], m["source"]) for m in zone["maps"]] == [(0, 0, "client"), (1, 0, "client"), (1, 1, "client")]
    assert zone["links"] == [[1, 0, 1, 1]]  # (0,0)-(1,0) removed as a wall


def test_recorded_zone_keeps_its_maps_and_gets_missing_ones(tmp_path):
    client = fake_client(tmp_path)
    recorded = {"zone": "egout", "name": "x", "source_video": "v.mkv", "tile_size": [100, 60],
                "maps": [{"x": 0, "y": 0, "source": "ocr"}, {"x": 1, "y": 0, "source": "ocr"}],
                "links": []}  # the recording never walked (0,0)-(1,0)
    zone, notes = build_zone("egout", {"client_subarea": 7}, client, recorded, tmp_path / "none.json")
    assert [(m["x"], m["y"], m["source"]) for m in zone["maps"]] == [(0, 0, "ocr"), (1, 0, "ocr"), (1, 1, "client")]
    assert zone["links"] == [[1, 0, 1, 1]]  # only the added map is joined to its neighbours
    assert zone["tile_size"] == [100, 60] and zone["source_video"] == "v.mkv"
    assert notes[0] == "1 map(s) added to the 2 recorded ones"


def test_reimport_does_not_duplicate_client_maps(tmp_path):
    client = fake_client(tmp_path)
    first, _ = build_zone("egout", {"client_subarea": 7}, client, None, tmp_path / "none.json")
    again, _ = build_zone("egout", {"client_subarea": 7}, client, first, tmp_path / "none.json")
    assert [(m["x"], m["y"]) for m in again["maps"]] == [(m["x"], m["y"]) for m in first["maps"]]


def test_reimport_rebuilds_passages_of_client_zones(tmp_path):
    client = fake_client(tmp_path)
    stale = {"zone": "egout", "name": "x", "source_video": None, "tile_size": [1, 1],
             "maps": [{"x": 0, "y": 0, "source": "client"}], "links": [[0, 0, 5, 5]]}
    zone, _ = build_zone("egout", {"client_subarea": 7}, client, stale, tmp_path / "none.json")
    assert [0, 0, 5, 5] not in zone["links"]
