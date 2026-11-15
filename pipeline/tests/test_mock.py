import json

from archimap.export import update_zone_index
from archimap.mock import ZONES, clean_mock_zones, write_mock_zones


def test_write_and_clean_keep_real_zones(tmp_path):
    update_zone_index(tmp_path, "real", "Real zone", 4)
    write_mock_zones(tmp_path)
    index = json.loads((tmp_path / "zones.json").read_text())["zones"]
    assert {z["zone"] for z in index} == {"real", *ZONES}
    for slug in ZONES:
        zone = json.loads((tmp_path / slug / "zone.json").read_text())
        assert all((tmp_path / slug / m["tile"]).is_file() for m in zone["maps"])

    clean_mock_zones(tmp_path)
    index = json.loads((tmp_path / "zones.json").read_text())["zones"]
    assert [z["zone"] for z in index] == ["real"]
    assert not any((tmp_path / slug).exists() for slug in ZONES)


def test_clean_removes_index_when_only_mocks(tmp_path):
    write_mock_zones(tmp_path)
    clean_mock_zones(tmp_path)
    assert not (tmp_path / "zones.json").exists()
