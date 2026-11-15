"""Split a frame stream into map visits and pick the best frame of each."""

from __future__ import annotations

import heapq
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

import cv2
import numpy as np

from .frames import Frame
from .models import Box, MapVisit

SMALL_WIDTH = 160


@dataclass(frozen=True)
class TransitionConfig:
    # Mean gray level (0-255) below which a frame counts as a loading frame.
    dark_mean: float = 25.0
    # Gray std below which a frame counts as near-uniform (loading screen).
    uniform_std: float = 8.0
    # A frame darker than this fraction of the current visit's recent
    # brightness is part of a loading fade. Catches short fades where no
    # sampled frame gets fully dark. 0 disables it.
    dip_ratio: float = 0.6
    # Mean abs difference between consecutive small frames that counts as a
    # hard cut, for map changes without a dark transition. 0 disables it:
    # large popups would otherwise split a visit.
    cut_diff: float = 0.0
    # Frames before and after a loading run closer than this are the same
    # map (fight start/end, a flash) and stay one visit.
    same_map_diff: float = 12.0
    # Visits shorter than this many frames are dropped as noise.
    min_segment_frames: int = 2
    # Number of sharpest frames kept per visit as best-frame candidates.
    candidates: int = 8
    # Frames kept from each end of a visit for exit-direction detection.
    motion_frames: int = 6


def small_gray(image: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    size = (SMALL_WIDTH, max(1, round(h * SMALL_WIDTH / w)))
    return cv2.resize(gray, size, interpolation=cv2.INTER_AREA).astype(np.float32)


def is_loading(small: np.ndarray, cfg: TransitionConfig) -> bool:
    return float(small.mean()) < cfg.dark_mean or float(small.std()) < cfg.uniform_std


def is_dip(small: np.ndarray, recent: list[np.ndarray], cfg: TransitionConfig) -> bool:
    if cfg.dip_ratio <= 0 or not recent:
        return False
    baseline = float(np.median([s.mean() for s in recent]))
    return float(small.mean()) < baseline * cfg.dip_ratio


def frame_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a - b).mean())


def is_cut(small: np.ndarray, prev: np.ndarray | None, cfg: TransitionConfig) -> bool:
    return cfg.cut_diff > 0 and prev is not None and frame_diff(small, prev) > cfg.cut_diff


def sharpness(image: np.ndarray) -> float:
    """Laplacian variance: higher means sharper."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


class _VisitBuilder:
    """Accumulates one visit while keeping memory bounded."""

    def __init__(self, cfg: TransitionConfig):
        self.cfg = cfg
        self.times: list[float] = []
        self.smalls: list[np.ndarray] = []
        self.coord_crops: list[np.ndarray] = []
        # Min-heap of (sharpness, seq, time, view, small); seq breaks ties
        # so arrays are never compared.
        self.candidates: list[tuple] = []

    def add(self, time: float, view: np.ndarray, small: np.ndarray,
            coord_crop: np.ndarray | None) -> None:
        item = (sharpness(view), len(self.times), time, view, small)
        if len(self.candidates) < self.cfg.candidates:
            heapq.heappush(self.candidates, item)
        else:
            heapq.heappushpop(self.candidates, item)
        self.times.append(time)
        self.smalls.append(small)
        if coord_crop is not None:
            self.coord_crops.append(coord_crop)

    def build(self, index: int) -> MapVisit | None:
        if len(self.times) < self.cfg.min_segment_frames:
            return None
        # Popups and passing monsters differ from the visit's median frame;
        # among candidates close to the median, take the sharpest.
        median = np.median(np.stack(self.smalls), axis=0)
        scored = [(float(np.abs(small - median).mean()), s, t, view)
                  for s, _, t, view, small in self.candidates]
        best_dist = min(c[0] for c in scored)
        eligible = [c for c in scored if c[0] <= best_dist * 1.5 + 8.0]
        _, s, t, view = max(eligible, key=lambda c: c[1])
        m = self.cfg.motion_frames
        return MapVisit(
            index=index,
            start_time=self.times[0],
            end_time=self.times[-1],
            video_time=t,
            image=view,
            sharpness=s,
            head=self.smalls[:m],
            tail=self.smalls[-m:],
            coord_crops=self.coord_crops,
        )


def segment(frames: Iterable[Frame], cfg: TransitionConfig,
            view_box: Box | None = None,
            coords_box: Box | None = None) -> Iterator[MapVisit]:
    """Yield one MapVisit per run of frames between loading transitions."""
    builder: _VisitBuilder | None = None
    prev: np.ndarray | None = None
    loading_seen = False
    index = 0

    def close() -> Iterator[MapVisit]:
        nonlocal index
        if builder is not None:
            visit = builder.build(index)
            if visit is not None:
                index += 1
                yield visit

    for frame in frames:
        view = view_box.crop(frame.image) if view_box else frame.image
        small = small_gray(view)
        recent = builder.smalls[-12:] if builder is not None else []
        if is_loading(small, cfg) or is_dip(small, recent, cfg):
            # Keep the visit open until we see what comes after the loading.
            loading_seen = True
            continue
        if builder is not None:
            if loading_seen:
                changed = frame_diff(small, builder.smalls[-1]) > cfg.same_map_diff
            else:
                changed = is_cut(small, prev, cfg)
            if changed:
                yield from close()
                builder = None
        loading_seen = False
        prev = small
        if builder is None:
            builder = _VisitBuilder(cfg)
        crop = coords_box.crop(frame.image).copy() if coords_box else None
        builder.add(frame.time, view.copy(), small, crop)
    yield from close()
