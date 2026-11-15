import numpy as np

from archimap.infer import edge_scores, exit_side, fill_coordinates, resolve_with_route
from archimap.models import MapVisit
from archimap.transitions import small_gray
from conftest import texture, with_character


def walk(seed, start, end, steps=6):
    """Small frames of a character walking from start to end (pixel coords)."""
    bg = texture(seed)
    xs = np.linspace(start[0], end[0], steps).astype(int)
    ys = np.linspace(start[1], end[1], steps).astype(int)
    return [small_gray(with_character(bg, x, y)) for x, y in zip(xs, ys)]


def visit(index, head=None, tail=None, coords=None, source=None):
    return MapVisit(index=index, start_time=0, end_time=1, video_time=0,
                    image=texture(index), sharpness=1.0, head=head or [], tail=tail or [],
                    coords=coords, source=source, confidence=1.0 if coords else 0.0)


def test_edge_scores_empty():
    assert edge_scores(None) == {"left": 0, "right": 0, "top": 0, "bottom": 0}


def test_exit_right_from_tail_and_entry():
    a = visit(0, tail=walk(1, (230, 80), (300, 80)))
    b = visit(1, head=walk(2, (2, 80), (60, 80)))
    assert exit_side(a, b)[0] == "right"


def test_exit_top_tail_only():
    a = visit(0, tail=walk(1, (150, 30), (150, 0)))
    assert exit_side(a, None)[0] == "top"


def test_no_motion_means_unknown():
    a = visit(0, tail=[small_gray(texture(1))] * 4)
    assert exit_side(a, None)[0] is None


def test_fill_forward_and_backward():
    right = walk(1, (230, 80), (300, 80))
    down = walk(1, (150, 145), (150, 170))
    visits = [
        visit(0, tail=down),                         # unknown, left via bottom
        visit(1, tail=right, coords=(3, 4), source="ocr"),
        visit(2, tail=right),                        # inferred from map 1
        visit(3),                                    # inferred from map 2
    ]
    fill_coordinates(visits)
    assert visits[0].coords == (3, 3)
    assert visits[2].coords == (4, 4)
    assert visits[3].coords == (5, 4)
    assert [v.source for v in visits] == ["inferred", "ocr", "inferred", "inferred"]


def test_route_breaks_ocr_ties():
    visits = [visit(0, coords=(-28, -56), source="ocr"),
              visit(1, coords=(28, -57), source="ocr"),  # misread tied with the right value
              visit(2, coords=(-28, -58), source="ocr")]
    visits[1].confidence = 0.5
    visits[1].candidates = {(28, -57): 0.5, (-28, -57): 0.5}
    resolve_with_route(visits)
    assert visits[1].coords == (-28, -57)


def test_route_keeps_confident_votes():
    visits = [visit(0, coords=(0, 0), source="ocr"), visit(1, coords=(5, 5), source="ocr")]
    visits[1].candidates = {(5, 5): 0.9, (0, 1): 0.1}
    visits[1].confidence = 0.9
    resolve_with_route(visits)
    assert visits[1].coords == (5, 5)
