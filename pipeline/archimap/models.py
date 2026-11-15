"""Shared data types for the pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass(frozen=True)
class Box:
    """A pixel rectangle in the source video frame."""

    x: int
    y: int
    w: int
    h: int

    @classmethod
    def parse(cls, text: str) -> Box:
        """Parse "x,y,w,h"."""
        try:
            parts = [int(p) for p in text.split(",")]
        except ValueError:
            raise ValueError(f"box must be x,y,w,h integers, got {text!r}") from None
        if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0:
            raise ValueError(f"box must be x,y,w,h with positive w and h, got {text!r}")
        return cls(*parts)

    def crop(self, image: np.ndarray) -> np.ndarray:
        h, w = image.shape[:2]
        x0, y0 = max(0, self.x), max(0, self.y)
        x1, y1 = min(w, self.x + self.w), min(h, self.y + self.h)
        if x1 <= x0 or y1 <= y0:
            raise ValueError(f"{self} lies outside the {w}x{h} frame")
        return image[y0:y1, x0:x1]


@dataclass
class MapVisit:
    """One continuous stay on a map, between two loading transitions."""

    index: int
    start_time: float
    end_time: float
    # Time and BGR view crop of the frame chosen to represent the map.
    video_time: float
    image: np.ndarray
    sharpness: float
    # Downscaled grayscale frames from the start and end of the visit,
    # used to guess which side the character entered and left from.
    head: list[np.ndarray]
    tail: list[np.ndarray]
    # Coordinates-box crops, sampled across the visit for OCR voting.
    coord_crops: list[np.ndarray] = field(default_factory=list)

    ocr_text: str = ""
    # Every value OCR read for this map, with its share of the readings.
    candidates: dict[tuple[int, int], float] = field(default_factory=dict)
    coords: tuple[int, int] | None = None
    source: str | None = None  # "ocr" | "inferred" | "manual"
    confidence: float = 0.0
    exit_side: str | None = None
    exit_score: float = 0.0
