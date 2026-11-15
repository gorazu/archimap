"""Read in-game [x,y] map coordinates with Tesseract."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
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


def parse_coords(text: str) -> tuple[int, int] | None:
    """Extract (x, y) from OCR text such as "[-5,12]"."""
    match = _COORDS.search(text.translate(_DASHES).replace(" ", ""))
    if not match:
        return None
    x, y = int(match.group(1)), int(match.group(2))
    if abs(x) > MAX_COORD or abs(y) > MAX_COORD:
        return None
    return x, y


# Coordinates are drawn as near-white text with a dark outline: keeping only
# pixels bright in every channel isolates the text on any background (Otsu
# alone fails on light walls). Each crop is binarized two ways that fail at
# different capture sizes (measured on 540p to 1440p captures): a fixed
# threshold, and one relative to the brightest text pixels with thickened
# strokes. Entries are (threshold, thicken); a threshold below 1 is a
# fraction of the crop's 99th-percentile brightness.
TEXT_VARIANTS: tuple[tuple[float, int], ...] = ((160, 0), (0.7, 3))
# Crops are resized to this height before OCR, so the text has the same
# size whatever the capture size. The coordinates box is about twice the
# text height, so the text ends up ~68px tall.
OCR_HEIGHT = 136


def preprocess(crop: np.ndarray, threshold: float | None = TEXT_VARIANTS[0][0],
               thicken: int = 0) -> np.ndarray:
    """Resize to OCR_HEIGHT and binarize to dark text on a white background.

    With `threshold`, text is the pixels brighter than it in every channel;
    without it, Otsu picks the threshold.
    """
    scale = OCR_HEIGHT / crop.shape[0]
    if threshold and crop.ndim == 3:
        level = cv2.resize(crop.min(axis=2), None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_CUBIC)
        if threshold < 1:
            threshold *= float(np.percentile(level, 99))
        _, binary = cv2.threshold(level, threshold, 255, cv2.THRESH_BINARY_INV)
        if thicken:
            binary = cv2.erode(binary, np.ones((thicken, thicken), np.uint8))
    else:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        # Text covers fewer pixels than background; make the background white.
        if binary.mean() < 127:
            binary = 255 - binary
    return cv2.copyMakeBorder(binary, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)


def _tesseract(binary: np.ndarray) -> OcrReading:
    text = "".join(pytesseract.image_to_string(binary, config=TESS_CONFIG).split())
    return OcrReading(text, parse_coords(text))


def read_coords(crop: np.ndarray,
                variants: tuple[tuple[float, int], ...] = TEXT_VARIANTS) -> list[OcrReading]:
    """One reading per binarization, plus Otsu if none of them parses."""
    readings = [_tesseract(preprocess(crop, t, k)) for t, k in variants]
    if all(r.coords is None for r in readings):
        readings.append(_tesseract(preprocess(crop, None)))
    return readings


# Images per Tesseract run when reading many crops at once.
BATCH_SIZE = 64


def _tesseract_batch(images: list[np.ndarray]) -> list[str]:
    """Text of each image, from a single Tesseract process.

    Starting one process per image is the slow part (it dominated run time),
    so images go through a list file; their texts come back separated by
    form feeds.
    """
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for i, image in enumerate(images):
            paths.append(os.path.join(tmp, f"{i}.png"))
            cv2.imwrite(paths[-1], image)
        listing = os.path.join(tmp, "list.txt")
        with open(listing, "w") as f:
            f.write("\n".join(paths) + "\n")
        out = subprocess.run(
            [pytesseract.pytesseract.tesseract_cmd, listing, "stdout", *TESS_CONFIG.split()],
            capture_output=True, text=True, check=True,
            # Batches run in parallel: one thread each avoids fighting for cores.
            env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        ).stdout
    pages = out.split("\f")
    if len(pages) != len(images):
        raise RuntimeError(f"Tesseract returned {len(pages)} pages for {len(images)} images")
    return ["".join(page.split()) for page in pages]


def _ocr_images(images: list[np.ndarray]) -> list[str]:
    """Texts of many images: batched, with the batches spread over all cores."""
    if not images:
        return []
    workers = os.cpu_count() or 4
    size = max(1, min(BATCH_SIZE, -(-len(images) // workers)))
    batches = [images[i:i + size] for i in range(0, len(images), size)]
    with ThreadPoolExecutor(workers) as pool:
        return [text for batch in pool.map(_tesseract_batch, batches) for text in batch]


def read_coords_many(crops: list[np.ndarray],
                     variants: tuple[tuple[float, int], ...] = TEXT_VARIANTS) -> list[list[OcrReading]]:
    """read_coords for many crops at once, much faster than one by one."""
    jobs = [(i, preprocess(crop, t, k)) for i, crop in enumerate(crops) for t, k in variants]
    readings: list[list[OcrReading]] = [[] for _ in crops]
    for (i, _), text in zip(jobs, _ocr_images([image for _, image in jobs])):
        readings[i].append(OcrReading(text, parse_coords(text)))
    # Otsu as a fallback where no binarization parsed, as in read_coords.
    retry = [i for i, rs in enumerate(readings) if all(r.coords is None for r in rs)]
    for i, text in zip(retry, _ocr_images([preprocess(crops[i], None) for i in retry])):
        readings[i].append(OcrReading(text, parse_coords(text)))
    return readings


def tally(readings: list[OcrReading]) -> dict[tuple[int, int], float]:
    """Share of all readings for each coordinate value read."""
    counts = Counter(r.coords for r in readings if r.coords is not None)
    return {coords: n / len(readings) for coords, n in counts.most_common()}


def vote(readings: list[OcrReading]) -> tuple[tuple[int, int] | None, float, str]:
    """Majority vote over several readings of the same map.

    Returns (coords, confidence, text of a winning reading). Confidence is
    the winners' share of all readings: Tesseract's own confidence is not
    reliable with a character whitelist (it often reports 0 for correct text).
    """
    shares = tally(readings)
    if not shares:
        return None, 0.0, readings[0].text if readings else ""
    coords, share = next(iter(shares.items()))
    text = next(r.text for r in readings if r.coords == coords)
    return coords, share, text


def sample_evenly(items: list, n: int) -> list:
    if len(items) <= n:
        return list(items)
    step = (len(items) - 1) / (n - 1)
    return [items[round(i * step)] for i in range(n)]
