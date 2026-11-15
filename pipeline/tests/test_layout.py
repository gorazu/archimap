import cv2
import numpy as np
import pytest

from archimap.layout import default_coords_box, detect_game_area, detect_layout, distinct_frames
from archimap.models import Box
from archimap.ocr import read_coords, vote
from conftest import needs_tesseract, shifted_texture


def window_frame(seed: int, w: int, h: int, game_w: int, game_h: int,
                 coords: str | None = None) -> np.ndarray:
    """A fake Dofus window: map on the left, chat panel right, UI bar below."""
    frame = np.zeros((h, w, 3), np.uint8)
    frame[:] = (35, 30, 28)  # chat panel
    frame[game_h:, :game_w] = (170, 205, 220)  # UI bar
    # Darkened like a dungeon floor, so the map has no near-white pixels.
    frame[:game_h, :game_w] = shifted_texture(seed, game_w, game_h) // 2
    border = max(2, w // 480)
    frame[:, game_w:game_w + border] = (90, 90, 90)
    frame[game_h:game_h + border, :game_w] = (240, 240, 240)
    rng = np.random.default_rng(seed)
    for y in range(20, h - 20, 18):  # changing chat text
        x = game_w + 10 + int(rng.integers(0, 40))
        cv2.line(frame, (x, y), (x + int(rng.integers(30, 200)), y), (200, 200, 120), 2)
    if coords is not None:
        scale = game_h / 837
        for color, width in (((0, 0, 0), 5), ((245, 245, 245), 2)):
            cv2.putText(frame, f"Coordonnees : {coords}", (round(22 * scale), round(84 * scale)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.85 * scale, color,
                        max(1, round(width * scale)), cv2.LINE_AA)
    return frame


@pytest.mark.parametrize("w, h", [(960, 540), (1920, 1080), (2560, 1440)])
def test_detect_game_area_any_size(w, h):
    game_w, game_h = round(w * 0.714), round(h * 0.777)
    frames = [window_frame(seed, w, h, game_w, game_h) for seed in range(8)]
    game = detect_game_area(frames)
    assert (game.x, game.y) == (0, 0)
    assert abs(game.w - game_w) <= 2
    assert abs(game.h - game_h) <= 2


def test_game_only_capture_is_full_frame():
    frames = [shifted_texture(seed, 640, 360) for seed in range(6)]
    assert detect_game_area(frames) == Box(0, 0, 640, 360)


def test_default_coords_box_scales_with_game_area():
    assert default_coords_box(Box(0, 0, 1371, 837)) == Box(175, 58, 150, 34)
    small = default_coords_box(Box(0, 0, 686, 419))
    assert (small.x, small.y, small.w, small.h) == (88, 29, 75, 17)


@needs_tesseract
@pytest.mark.parametrize("w, h", [(1280, 720), (1920, 1080)])
def test_detect_layout_finds_label_and_reads_coords(w, h):
    game_w, game_h = round(w * 0.714), round(h * 0.777)
    frames = [window_frame(seed, w, h, game_w, game_h, "-26, -57") for seed in range(4)]
    layout = detect_layout(frames)
    assert layout.coords_found
    assert vote(read_coords(layout.coords.crop(frames[0])))[0] == (-26, -57)


@needs_tesseract
def test_detect_layout_falls_back_to_default_position():
    frames = [window_frame(seed, 1920, 1080, 1371, 837) for seed in range(3)]
    layout = detect_layout(frames)
    assert not layout.coords_found
    assert layout.coords == default_coords_box(layout.game)


def test_distinct_frames_skips_repeats_and_dark():
    a, b = shifted_texture(1, 160, 90), shifted_texture(2, 160, 90)
    dark = np.zeros_like(a)
    picked = distinct_frames([a, a, dark, a, b, b], n=5)
    assert len(picked) == 2
    assert picked[0] is a and picked[1] is b
