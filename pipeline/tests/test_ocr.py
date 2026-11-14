import pytest

from archimap.ocr import OcrReading, parse_coords, read_coords, sample_evenly, vote
from conftest import draw_coords, needs_tesseract, texture


@pytest.mark.parametrize("text, expected", [
    ("[-5,12]", (-5, 12)),
    ("-5, 12", (-5, 12)),
    ("[12,-3]", (12, -3)),
    ("−5,12", (-5, 12)),
    ("[ 0 , 0 ]", (0, 0)),
    ("x[-25,-31]]", (-25, -31)),
])
def test_parse_coords(text, expected):
    assert parse_coords(text) == expected


@pytest.mark.parametrize("text", ["", "abc", "[5]", "[999,1]", "5;12"])
def test_parse_coords_rejects(text):
    assert parse_coords(text) is None


def test_vote_majority():
    readings = [
        OcrReading("[-5,12]", (-5, 12), 0.9),
        OcrReading("[-5,12]", (-5, 12), 0.8),
        OcrReading("[-6,12]", (-6, 12), 0.9),
        OcrReading("", None, 0.0),
    ]
    coords, confidence, text = vote(readings)
    assert coords == (-5, 12)
    assert text == "[-5,12]"
    assert confidence == pytest.approx(0.5 * 0.85)


def test_vote_nothing_parsed():
    assert vote([OcrReading("??", None, 0.1)])[0] is None
    assert vote([]) == (None, 0.0, "")


def test_sample_evenly():
    assert sample_evenly([1, 2, 3], 7) == [1, 2, 3]
    assert sample_evenly(list(range(10)), 3) == [0, 4, 9] or sample_evenly(list(range(10)), 3) == [0, 5, 9]


@needs_tesseract
@pytest.mark.parametrize("text, expected", [("[-5,12]", (-5, 12)), ("[14,-3]", (14, -3))])
def test_read_coords_rendered(text, expected):
    frame = draw_coords(texture(1), text)
    crop = frame[10:46, 10:160]
    assert read_coords(crop).coords == expected
