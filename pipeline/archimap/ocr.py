"""Read in-game [x,y] map coordinates with Tesseract."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

import cv2
import numpy as np
import pytesseract

TESS_CONFIG = "--psm 7 -c tessedit_char_whitelist=-0123456789,[]"
_COORDS = re.compile(r"(-?\d{1,3}),(-?\d{1,3})")
_DASHES = str.maketrans({"−": "-", "–": "-", "—": "-"})
# Dofus Retro coordinates stay well inside this range.
MAX_COORD = 150


@dataclass(frozen=True)
class OcrReading:
    text: str
    coords: tuple[int, int] | None
    confidence: float  # 0..1


def parse_coords(text: str) -> tuple[int, int] | None:
    """Extract (x, y) from OCR text such as "[-5,12]"."""
    match = _COORDS.search(text.translate(_DASHES).replace(" ", ""))
    if not match:
        return None
    x, y = int(match.group(1)), int(match.group(2))
    if abs(x) > MAX_COORD or abs(y) > MAX_COORD:
        return None
    return x, y


def preprocess(crop: np.ndarray, scale: int = 4) -> np.ndarray:
    """Upscale and binarize to dark text on a white background."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Text covers fewer pixels than background; make the background white.
    if binary.mean() < 127:
        binary = 255 - binary
    return cv2.copyMakeBorder(binary, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)


def read_coords(crop: np.ndarray) -> OcrReading:
    data = pytesseract.image_to_data(
        preprocess(crop), config=TESS_CONFIG, output_type=pytesseract.Output.DICT
    )
    words, confs = [], []
    for word, conf in zip(data["text"], data["conf"]):
        if word.strip():
            words.append(word.strip())
            if float(conf) >= 0:
                confs.append(float(conf))
    text = "".join(words)
    confidence = sum(confs) / len(confs) / 100 if confs else 0.0
    return OcrReading(text, parse_coords(text), confidence)


def vote(readings: list[OcrReading]) -> tuple[tuple[int, int] | None, float, str]:
    """Majority vote over several readings of the same map.

    Returns (coords, confidence, text of a winning reading). Confidence is
    the winners' share of all readings times their mean Tesseract confidence.
    """
    if not readings:
        return None, 0.0, ""
    counts = Counter(r.coords for r in readings if r.coords is not None)
    if not counts:
        return None, 0.0, readings[0].text
    coords, n = counts.most_common(1)[0]
    winners = [r for r in readings if r.coords == coords]
    mean_conf = sum(r.confidence for r in winners) / len(winners)
    return coords, n / len(readings) * mean_conf, winners[0].text


def sample_evenly(items: list, n: int) -> list:
    if len(items) <= n:
        return list(items)
    step = (len(items) - 1) / (n - 1)
    return [items[round(i * step)] for i in range(n)]
