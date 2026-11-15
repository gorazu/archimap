"""Infer map coordinates from the direction the character left a map."""

from __future__ import annotations

import numpy as np

from .models import MapVisit

SIDES = ("left", "right", "top", "bottom")
# In-game y grows downward.
DELTA = {"left": (-1, 0), "right": (1, 0), "top": (0, -1), "bottom": (0, 1)}
OPPOSITE = {"left": "right", "right": "left", "top": "bottom", "bottom": "top"}
# OCR votes below this share are checked against the route.
AMBIGUOUS_SHARE = 0.75


def motion_mask(smalls: list[np.ndarray], threshold: float = 25.0) -> np.ndarray | None:
    """Pixels that changed between any two consecutive small frames."""
    if len(smalls) < 2:
        return None
    mask = np.zeros(smalls[0].shape, bool)
    for a, b in zip(smalls, smalls[1:]):
        mask |= np.abs(b - a) > threshold
    return mask


def edge_scores(mask: np.ndarray | None, margin: float = 0.2) -> dict[str, float]:
    """Share of the motion that falls within `margin` of each screen edge."""
    if mask is None or not mask.any():
        return dict.fromkeys(SIDES, 0.0)
    h, w = mask.shape
    mh, mw = max(1, int(h * margin)), max(1, int(w * margin))
    total = float(mask.sum())
    return {
        "left": mask[:, :mw].sum() / total,
        "right": mask[:, -mw:].sum() / total,
        "top": mask[:mh].sum() / total,
        "bottom": mask[-mh:].sum() / total,
    }


def exit_side(visit: MapVisit, next_visit: MapVisit | None,
              min_score: float = 0.35) -> tuple[str | None, float]:
    """Guess which side the character left `visit` from.

    Combines motion at the end of this visit with motion at the start of
    the next one (where the character appears on the opposite side).
    """
    sources = []
    exit_mask = motion_mask(visit.tail)
    if exit_mask is not None and exit_mask.any():
        sources.append(edge_scores(exit_mask))
    entry_mask = motion_mask(next_visit.head) if next_visit is not None else None
    if entry_mask is not None and entry_mask.any():
        entry = edge_scores(entry_mask)
        sources.append({s: entry[OPPOSITE[s]] for s in SIDES})
    if not sources:
        return None, 0.0
    scores = {s: sum(src[s] for src in sources) / len(sources) for s in SIDES}
    side = max(SIDES, key=lambda s: scores[s])
    if scores[side] < min_score:
        return None, scores[side]
    return side, scores[side]


def fill_coordinates(visits: list[MapVisit]) -> None:
    """Fill missing coordinates from neighbours, flagged as "inferred"."""
    for visit, nxt in zip(visits, visits[1:]):
        visit.exit_side, visit.exit_score = exit_side(visit, nxt)

    for prev, cur in zip(visits, visits[1:]):
        if cur.coords is None and prev.coords is not None and prev.exit_side:
            dx, dy = DELTA[prev.exit_side]
            cur.coords = (prev.coords[0] + dx, prev.coords[1] + dy)
            cur.source = "inferred"
            cur.confidence = prev.exit_score

    # Backward pass for visits before the first known position.
    for cur, nxt in reversed(list(zip(visits, visits[1:]))):
        if cur.coords is None and nxt.coords is not None and cur.exit_side:
            dx, dy = DELTA[cur.exit_side]
            cur.coords = (nxt.coords[0] - dx, nxt.coords[1] - dy)
            cur.source = "inferred"
            cur.confidence = cur.exit_score


def _adjacent(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) == 1


def resolve_with_route(visits: list[MapVisit]) -> None:
    """For uncertain OCR votes, prefer the candidate next to the neighbouring maps.

    Walking moves one map at a time, so consecutive visits are adjacent. A
    misread that wins (or ties) the vote usually breaks that.
    """
    for i, visit in enumerate(visits):
        if (visit.source != "ocr" or visit.confidence >= AMBIGUOUS_SHARE
                or len(visit.candidates) < 2):
            continue
        neighbours = [v.coords for v in visits[max(0, i - 1):i + 2]
                      if v is not visit and v.coords is not None]

        def fit(coords: tuple[int, int]) -> int:
            return sum(_adjacent(coords, n) for n in neighbours)

        best = max(visit.candidates, key=lambda c: (fit(c), visit.candidates[c]))
        if fit(best) > fit(visit.coords):
            visit.coords, visit.confidence = best, visit.candidates[best]


def route_links(visits: list[MapVisit]) -> list[tuple[tuple[int, int], tuple[int, int]]]:
    """Passages the player actually took: consecutive visits to adjacent maps.

    Two neighbouring maps aren't always connected (walls), so the route is
    a better source for the map's corridors than adjacency alone.
    """
    links = set()
    for a, b in zip(visits, visits[1:]):
        if a.coords and b.coords and _adjacent(a.coords, b.coords):
            links.add(tuple(sorted((a.coords, b.coords))))
    return sorted(links)
