"""Merge repeated visits to the same map."""

from __future__ import annotations

from .models import MapVisit

_SOURCE_RANK = {"manual": 2, "ocr": 1, "inferred": 0}


def _quality(visit: MapVisit) -> tuple:
    return (_SOURCE_RANK.get(visit.source or "", -1), visit.confidence, visit.sharpness)


def dedupe(visits: list[MapVisit]) -> list[MapVisit]:
    """Keep the best visit per coordinate, sorted by (y, x).

    Visits without coordinates are dropped; the report still lists them.
    """
    best: dict[tuple[int, int], MapVisit] = {}
    for visit in visits:
        if visit.coords is None:
            continue
        current = best.get(visit.coords)
        if current is None or _quality(visit) > _quality(current):
            best[visit.coords] = visit
    return sorted(best.values(), key=lambda v: (v.coords[1], v.coords[0]))
