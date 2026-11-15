import json

import cv2
import numpy as np

from archimap.extract import main
from conftest import black, draw_coords, needs_ffmpeg, needs_tesseract, shifted_texture, with_character

W, H, FPS = 640, 360, 12


def write_video(path, maps):
    """maps: list of (seed, coords_text, exit_motion) where exit_motion is
    (start_xy, end_xy) of the character over the last second, or None."""
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for i, (seed, text, motion, entry) in enumerate(maps):
        bg = draw_coords(shifted_texture(seed, W, H), text)
        n = FPS * 2
        for f in range(n):
            frame = bg
            if entry and f < FPS // 2:
                t = f / (FPS // 2)
                x = int(entry[0][0] + (entry[1][0] - entry[0][0]) * t)
                y = int(entry[0][1] + (entry[1][1] - entry[0][1]) * t)
                frame = with_character(bg, x, y, 20)
            elif motion and f >= n - FPS:
                t = (f - (n - FPS)) / (FPS - 1)
                x = int(motion[0][0] + (motion[1][0] - motion[0][0]) * t)
                y = int(motion[0][1] + (motion[1][1] - motion[0][1]) * t)
                frame = with_character(bg, x, y, 20)
            writer.write(frame)
        if i < len(maps) - 1:
            for _ in range(FPS // 2):
                writer.write(black(W, H))
    writer.release()


@needs_ffmpeg
@needs_tesseract
def test_end_to_end(tmp_path):
    video = tmp_path / "clip.mp4"
    to_right = ((480, 200), (620, 200))
    from_left = ((0, 200), (100, 200))
    write_video(video, [
        (1, "[-5,12]", to_right, None),
        (2, "[-4,12]", to_right, from_left),
        (3, "", None, from_left),          # OCR has nothing: inferred as [-3,12]
        (1, "[-5,12]", None, None),        # revisit of the first map
    ])
    data_dir, out_dir = tmp_path / "data", tmp_path / "out"
    code = main([str(video), "--zone", "e2e", "--coords-box", "10,10,150,36",
                 "--data-dir", str(data_dir), "--out-dir", str(out_dir)])
    assert code == 0

    zone = json.loads((data_dir / "e2e" / "zone.json").read_text())
    placed = {(m["x"], m["y"]): m["source"] for m in zone["maps"]}
    assert placed == {(-5, 12): "ocr", (-4, 12): "ocr", (-3, 12): "inferred"}
    assert zone["tile_size"] == [W, H]
    assert (out_dir / "e2e" / "report.html").is_file()
    index = json.loads((data_dir / "zones.json").read_text())
    assert index == {"zones": [{"zone": "e2e", "name": "e2e", "maps": 3}]}


@needs_ffmpeg
def test_preview(tmp_path):
    video = tmp_path / "clip.mp4"
    write_video(video, [(1, "[0,0]", None, None)])
    assert main([str(video), "--preview", "0.5", "--coords-box", "10,10,150,36",
                 "--out-dir", str(tmp_path)]) == 0
    assert (tmp_path / "preview_clip.png").is_file()
