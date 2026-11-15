import numpy as np

from archimap.infer import (edge_scores, exit_side, fill_coordinates, place_between_neighbours,
                            resolve_with_route, route_links)
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


def test_route_links_from_consecutive_adjacent_visits():
    visits = [visit(0, coords=(0, 0), source="ocr"), visit(1, coords=(1, 0), source="ocr"),
              visit(2, coords=(0, 0), source="ocr"),  # back again: same link
              visit(3, coords=(5, 5), source="ocr"),  # teleport: no link
              visit(4), visit(5, coords=(5, 6), source="ocr")]
    assert route_links(visits) == [((0, 0), (1, 0))]


def test_misread_placed_from_neighbours_and_partial_text():
    """Real case: white fur behind the text, OCR read "-33,451-" once."""
    visits = [visit(0, coords=(-34, -51), source="ocr"),
              visit(1, coords=(-33, 54), source="ocr"),
              visit(2, coords=(-33, -52), source="ocr")]
    visits[1].confidence = 0.05
    visits[1].ocr_texts = ["-33,451-", "-33,451-", "", "", ""]
    assert place_between_neighbours(visits) == [visits[1]]
    assert visits[1].coords == (-33, -51)
    assert visits[1].source == "inferred"


def test_straight_line_has_a_single_option():
    visits = [visit(0, coords=(0, 0), source="ocr"), visit(1), visit(2, coords=(0, 2), source="ocr")]
    place_between_neighbours(visits)
    assert visits[1].coords == (0, 1)


def test_two_options_without_text_drop_the_bad_reading():
    visits = [visit(0, coords=(0, 0), source="ocr"),
              visit(1, coords=(9, 9), source="ocr"),
              visit(2, coords=(1, 1), source="ocr")]
    visits[1].confidence = 0.1
    assert place_between_neighbours(visits) == []
    assert visits[1].coords is None  # left to exit-side inference


def test_reliable_or_fitting_reads_are_kept():
    visits = [visit(0, coords=(0, 0), source="ocr"),
              visit(1, coords=(1, 0), source="ocr"),
              visit(2, coords=(1, 1), source="ocr")]
    visits[1].confidence = 0.2  # low, but fits the route
    place_between_neighbours(visits)
    assert visits[1].coords == (1, 0) and visits[1].source == "ocr"
