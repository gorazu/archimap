import cv2
import numpy as np
import pytest

from archimap.frames import Frame


def texture(seed: int, w: int = 320, h: int = 180) -> np.ndarray:
    """A sharp, high-contrast fake map background."""
    rng = np.random.default_rng(seed)
    blocks = rng.integers(40, 256, (h // 8, w // 8, 3), dtype=np.uint8)
    return cv2.resize(blocks, (w, h), interpolation=cv2.INTER_NEAREST)


def shifted_texture(seed: int, w: int, h: int) -> np.ndarray:
    """Map content that, unlike interface borders, moves between maps."""
    rng = np.random.default_rng(seed + 100)
    return np.roll(texture(seed, w, h), (int(rng.integers(0, 8)), int(rng.integers(0, 8))), (0, 1))


def with_character(image: np.ndarray, x: int, y: int, size: int = 14) -> np.ndarray:
    out = image.copy()
    cv2.rectangle(out, (x, y), (x + size, y + size), (255, 0, 255), -1)
    return out


def black(w: int = 320, h: int = 180) -> np.ndarray:
    return np.zeros((h, w, 3), np.uint8)


def frames_from(images: list[np.ndarray], fps: float = 6.0) -> list[Frame]:
    return [Frame(index=i, time=i / fps, image=img) for i, img in enumerate(images)]


def draw_coords(image: np.ndarray, text: str, box=(10, 10, 150, 36)) -> np.ndarray:
    x, y, w, h = box
    out = image.copy()
    cv2.rectangle(out, (x, y), (x + w, y + h), (30, 30, 30), -1)
    if text:
        cv2.putText(out, text, (x + 8, y + h - 10), cv2.FONT_HERSHEY_SIMPLEX,
                    0.8, (255, 255, 255), 2, cv2.LINE_AA)
    return out


def has_tool(name: str) -> bool:
    import shutil
    return shutil.which(name) is not None


needs_tesseract = pytest.mark.skipif(not has_tool("tesseract"), reason="tesseract not installed")
needs_ffmpeg = pytest.mark.skipif(not has_tool("ffmpeg"), reason="ffmpeg not installed")
