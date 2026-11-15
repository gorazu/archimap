"""Frame extraction with FFmpeg."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    duration: float


@dataclass
class Frame:
    index: int
    time: float
    image: np.ndarray  # BGR, uint8


def probe(path: Path) -> VideoInfo:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height:format=duration",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    return VideoInfo(
        width=int(stream["width"]),
        height=int(stream["height"]),
        duration=float(data.get("format", {}).get("duration", 0.0)),
    )


def iter_frames(path: Path, fps: float) -> Iterator[Frame]:
    """Stream frames sampled at `fps` without writing them to disk."""
    info = probe(path)
    frame_bytes = info.width * info.height * 3
    proc = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-i", str(path),
            "-vf", f"fps={fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
        ],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    try:
        index = 0
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            image = np.frombuffer(buf, np.uint8).reshape(info.height, info.width, 3)
            yield Frame(index=index, time=index / fps, image=image)
            index += 1
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def iter_keyframes(path: Path) -> Iterator[np.ndarray]:
    """Only the keyframes (every few seconds), without decoding the frames between.

    Much faster than iter_frames when only a sample spread over the video
    is needed, as for layout detection.
    """
    info = probe(path)
    frame_bytes = info.width * info.height * 3
    proc = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-skip_frame", "nokey", "-i", str(path),
            "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
        ],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    try:
        while len(buf := proc.stdout.read(frame_bytes)) == frame_bytes:
            yield np.frombuffer(buf, np.uint8).reshape(info.height, info.width, 3)
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def grab_frame(path: Path, time: float, dest: Path) -> None:
    """Save a single frame at `time` seconds as an image file."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", str(time), "-i", str(path),
         "-frames:v", "1", str(dest)],
        check=True,
    )
