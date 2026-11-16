import json

import pytest

from archimap.corrections import apply_link_corrections, main

MAPS = {(0, 0), (1, 0), (1, 1), (0, 1)}


def write(tmp_path, data):
    path = tmp_path / "zone.json"
    path.write_text(json.dumps(data))
    return path


def test_no_file_keeps_route_links(tmp_path):
    links, notes = apply_link_corrections([((1, 0), (0, 0))], tmp_path / "missing.json", MAPS)
    assert links == [((0, 0), (1, 0))] and notes == []


def test_add_and_remove(tmp_path):
    path = write(tmp_path, {"add_links": [[0, 1, 0, 0]], "remove_links": [[1, 0, 1, 1]]})
    links, notes = apply_link_corrections([((0, 0), (1, 0)), ((1, 0), (1, 1))], path, MAPS)
    assert links == [((0, 0), (0, 1)), ((0, 0), (1, 0))]
    assert notes == ["1 passage(s) added, 1 removed by zone.json"]
    # Applying again changes nothing.
    assert apply_link_corrections(links, path, MAPS)[0] == links


def test_links_to_unknown_maps_are_skipped(tmp_path):
    path = write(tmp_path, {"add_links": [[1, 1, 2, 1]]})
    links, notes = apply_link_corrections([], path, MAPS)
    assert links == [] and "not a map of this zone" in notes[0]


def test_non_neighbours_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="not neighbouring"):
        apply_link_corrections([], write(tmp_path, {"add_links": [[0, 0, 1, 1]]}), MAPS)


def test_command_updates_zone_json(tmp_path, monkeypatch):
    (tmp_path / "web").mkdir()
    (tmp_path / "pipeline").mkdir()
    (tmp_path / "zones").mkdir()
    (tmp_path / "zones" / "z.json").write_text(json.dumps({"add_links": [[0, 0, 0, 1]]}))
    zone_dir = tmp_path / "data" / "z"
    zone_dir.mkdir(parents=True)
    zone = {"zone": "z", "maps": [{"x": x, "y": y} for x, y in MAPS], "links": [[0, 0, 1, 0]]}
    (zone_dir / "zone.json").write_text(json.dumps(zone))
    monkeypatch.chdir(tmp_path)
    assert main(["z", "--data-dir", str(tmp_path / "data")]) == 0
    assert json.loads((zone_dir / "zone.json").read_text())["links"] == [[0, 0, 0, 1], [0, 0, 1, 0]]
