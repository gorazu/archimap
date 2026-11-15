import json

from archimap.dedupe import dedupe
from archimap.export import export_zone, update_zone_index
from archimap.models import MapVisit
from conftest import texture


def visit(index, coords, source, confidence=0.5, sharpness=1.0):
    return MapVisit(index=index, start_time=index, end_time=index + 1, video_time=index + 0.5,
                    image=texture(index), sharpness=sharpness, head=[], tail=[],
                    coords=coords, source=source, confidence=confidence)


def test_dedupe_prefers_ocr_then_confidence_then_sharpness():
    visits = [
        visit(0, (0, 0), "inferred", 0.9),
        visit(1, (0, 0), "ocr", 0.6),
        visit(2, (0, 0), "ocr", 0.6, sharpness=5.0),
        visit(3, (1, -1), "ocr", 0.9),
        visit(4, None, None),
    ]
    maps = dedupe(visits)
    assert [m.index for m in maps] == [3, 2]  # sorted by (y, x)


def test_export_zone(tmp_path):
    maps = [visit(0, (-5, 12), "ocr", 0.87654), visit(1, (-4, 12), "inferred", 0.4)]
    path = export_zone(maps, "test-zone", "Test zone", "clip.mp4", tmp_path,
                       links=[((-5, 12), (-4, 12))])
    data = json.loads(path.read_text())
    assert data["links"] == [[-5, 12, -4, 12]]
    assert data["zone"] == "test-zone"
    assert data["tile_size"] == [320, 180]
    assert data["maps"][0] == {
        "x": -5, "y": 12, "tile": "tiles/-5_12.webp", "thumb": "thumbs/-5_12.png",
        "source": "ocr", "confidence": 0.877, "video_time": 0.5,
    }
    for m in data["maps"]:
        assert (tmp_path / "test-zone" / m["tile"]).is_file()
        assert (tmp_path / "test-zone" / m["thumb"]).is_file()


def test_export_replaces_stale_tiles(tmp_path):
    export_zone([visit(0, (0, 0), "ocr")], "z", "z", "a.mp4", tmp_path)
    export_zone([visit(1, (1, 1), "ocr")], "z", "z", "b.mp4", tmp_path)
    assert [p.name for p in (tmp_path / "z" / "tiles").iterdir()] == ["1_1.webp"]


def test_update_zone_index(tmp_path):
    update_zone_index(tmp_path, "b", "Zone B", 3)
    update_zone_index(tmp_path, "a", "zone A", 5)
    update_zone_index(tmp_path, "b", "Zone B", 4)
    data = json.loads((tmp_path / "zones.json").read_text())
    assert data == {"zones": [
        {"zone": "a", "name": "zone A", "maps": 5},
        {"zone": "b", "name": "Zone B", "maps": 4},
    ]}
