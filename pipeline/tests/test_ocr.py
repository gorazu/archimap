import pytest

from archimap.ocr import OcrReading, parse_coords, read_coords, sample_evenly, tally, vote
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
        OcrReading("[-5,12]", (-5, 12)),
        OcrReading("[-5,12]", (-5, 12)),
        OcrReading("[-6,12]", (-6, 12)),
        OcrReading("", None),
    ]
    coords, confidence, text = vote(readings)
    assert coords == (-5, 12)
    assert text == "[-5,12]"
    assert confidence == pytest.approx(0.5)


def test_vote_nothing_parsed():
    assert vote([OcrReading("??", None)])[0] is None
    assert vote([]) == (None, 0.0, "")


def test_sample_evenly():
    assert sample_evenly([1, 2, 3], 7) == [1, 2, 3]
    assert sample_evenly(list(range(10)), 3) == [0, 4, 9] or sample_evenly(list(range(10)), 3) == [0, 5, 9]


@needs_tesseract
@pytest.mark.parametrize("text, expected", [("[-5,12]", (-5, 12)), ("[14,-3]", (14, -3))])
def test_read_coords_rendered(text, expected):
    frame = draw_coords(texture(1), text)
    crop = frame[10:46, 10:160]
    assert vote(read_coords(crop))[0] == expected


@needs_tesseract
def test_read_white_text_on_light_background():
    """Otsu fails here: the background is nearly as bright as the text."""
    import cv2
    import numpy as np
    crop = np.full((40, 180, 3), (150, 175, 190), np.uint8)
    cv2.rectangle(crop, (0, 25), (180, 40), (40, 60, 70), -1)
    cv2.line(crop, (0, 40), (180, 0), (60, 80, 90), 6)
    for color, width in (((20, 20, 20), 5), ((245, 245, 245), 2)):
        cv2.putText(crop, "-26, -55", (8, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, width, cv2.LINE_AA)
    assert vote(read_coords(crop))[0] == (-26, -55)


def test_tally_shares():
    readings = [OcrReading("a", (1, 2)), OcrReading("b", (1, 2)), OcrReading("c", (3, 4)), OcrReading("", None)]
    assert tally(readings) == {(1, 2): 0.5, (3, 4): 0.25}
