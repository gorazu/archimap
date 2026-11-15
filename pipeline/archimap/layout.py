"""Find the game area and the coordinates text in a capture of any size.

With the modern UI, the Dofus Retro window scales evenly, so nothing here
uses fixed pixel positions: the game area is found from the borders of the
chat panel and UI bar, and the coordinates from their "Coordonnées" label,
sized relative to that label.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import cv2
import numpy as np
import pytesseract

from .models import Box

# An interface border must be this many times stronger than a typical edge.
EDGE_RATIO = 10.0
# Region searched for the "Coordonnées : x, y" label, as fractions of the game area.
LABEL_REGION = (0.35, 0.15)
# Where the numbers are when the label can't be found, as fractions of the
# game area (measured on a 1920x1080 full-window capture).
DEFAULT_COORDS = (0.1276, 0.0693, 0.1094, 0.0406)
# Brightness above which label pixels count as white text.
LABEL_THRESHOLD = 185


@dataclass(frozen=True)
class Layout:
    game: Box
    coords: Box
    coords_found: bool  # False when DEFAULT_COORDS was used


def _edge_profiles(grays: list[np.ndarray], axis: int) -> np.ndarray:
    """Edge strength per column (axis=1) or row (axis=0), median over frames.

    Map content changes between frames but interface borders don't, so the
    median keeps the borders and drops the rest.
    """
    return np.median([np.abs(np.diff(g, axis=axis)).mean(axis=1 - axis) for g in grays], axis=0)


def _find_border(profile: np.ndarray, lo: int, hi: int) -> int | None:
    """Position of the strongest border in profile[lo:hi], or None."""
    segment = profile[lo:hi]
    if segment.size == 0:
        return None
    peak = int(np.argmax(segment))
    # Floor the baseline: flat images have a typical edge strength of ~0.
    if segment[peak] < EDGE_RATIO * max(float(np.median(profile)), 1.0):
        return None
    # A border is a few pixels wide with an edge on each side: keep its first one.
    window = max(2, len(profile) // 200)
    strong = np.nonzero(segment[max(0, peak - window):peak + 1] > 0.3 * segment[peak])[0]
    return lo + max(0, peak - window) + int(strong[0]) + 1


def distinct_frames(frames: Iterable[np.ndarray], n: int, min_diff: float = 15.0) -> list[np.ndarray]:
    """Up to n frames that each show a clearly different picture.

    Border detection takes a median over frames, so frames of one map seen
    many times would let that map's own edges pass for interface borders.
    Dark (loading) frames are skipped. Only kept frames stay in memory, so
    a long stream (all keyframes of a video) can be passed.
    """
    picked: list[np.ndarray] = []
    smalls: list[np.ndarray] = []
    first: list[np.ndarray] = []  # fallback if no frame qualifies
    for frame in frames:
        if len(first) < n:
            first.append(frame)
        small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36),
                           interpolation=cv2.INTER_AREA).astype(np.float32)
        if small.mean() < 25 or any(np.abs(small - s).mean() < min_diff for s in smalls):
            continue
        picked.append(frame)
        smalls.append(small)
        if len(picked) == n:
            break
    return picked or first


def detect_game_area(frames: list[np.ndarray]) -> Box:
    """The game view: left of the chat panel and above the UI bar, if present."""
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32) for f in frames]
    h, w = grays[0].shape
    # Skip the last pixels: captures often have a 1px edge artefact there.
    right = _find_border(_edge_profiles(grays, axis=1), w // 2, w - 3) or w
    bottom = _find_border(_edge_profiles([g[:, :right] for g in grays], axis=0), h // 2, h - 3) or h
    return Box(0, 0, right, bottom)


def default_coords_box(game: Box) -> Box:
    fx, fy, fw, fh = DEFAULT_COORDS
    return Box(game.x + round(game.w * fx), game.y + round(game.h * fy),
               round(game.w * fw), round(game.h * fh))


def find_coords_label(frame: np.ndarray, game: Box) -> Box | None:
    """Box around the numbers after the "Coordonnées :" label, or None."""
    region = Box(game.x, game.y, round(game.w * LABEL_REGION[0]), round(game.h * LABEL_REGION[1]))
    level = region.crop(frame).min(axis=2)
    # Normalize to the text size this was tuned on (837px-tall game area, x2).
    scale = 2 * 837 / game.h
    level = cv2.resize(level, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    _, binary = cv2.threshold(level, LABEL_THRESHOLD, 255, cv2.THRESH_BINARY_INV)
    data = pytesseract.image_to_data(binary, config="--psm 6", output_type=pytesseract.Output.DICT)
    words = [(t.strip(), *(d / scale for d in (data["left"][i], data["top"][i],
                                               data["width"][i], data["height"][i])))
             for i, t in enumerate(data["text"]) if t.strip()]
    for i, (text, left, top, width, height) in enumerate(words):
        # Tolerant to misreads such as "Coaordonnées" or "Cordonnees".
        if len(text) < 7 or "ord" not in text.lower():
            continue
        start = left + width
        for other, o_left, o_top, o_width, _ in words[i + 1:i + 3]:
            if other.startswith(":") and abs(o_top - top) < height:
                start = o_left + o_width
                break
        else:
            start += 0.08 * width
        return Box(region.x + round(start + 0.03 * width), region.y + round(top - 0.5 * height),
                   round(1.15 * width), round(2 * height))
    return None


def detect_layout(frames: list[np.ndarray], game: Box | None = None) -> Layout:
    """Find the game area (unless given) and the coordinates box."""
    game = game or detect_game_area(frames)
    found = [b for f in frames if (b := find_coords_label(f, game))]
    if not found:
        return Layout(game, default_coords_box(game), coords_found=False)
    # Median per side over frames, in case a tooltip covered the label once.
    x, y, w, h = (round(float(np.median([getattr(b, k) for b in found]))) for k in "xywh")
    return Layout(game, Box(x, y, w, h), coords_found=True)
