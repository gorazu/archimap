"""CLI: turn a gameplay video into zone map data.

    python -m archimap.extract video.mp4 --zone zone-slug [--coords-box x,y,w,h] [--fps 6]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

from .dedupe import dedupe
from .export import export_zone
from .frames import grab_frame, iter_frames, probe
from .infer import fill_coordinates
from .models import Box, MapVisit
from .ocr import read_coords, sample_evenly, vote
from .report import write_report
from .transitions import TransitionConfig, segment

OCR_SAMPLES = 7


def find_repo_root(start: Path) -> Path:
    for path in [start, *start.parents]:
        if (path / "web").is_dir() and (path / "pipeline").is_dir():
            return path
    return start


def parse_point(text: str) -> tuple[int, int]:
    try:
        x, y = (int(p) for p in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected x,y integers, got {text!r}") from None
    return x, y


def parse_box(text: str) -> Box:
    try:
        return Box.parse(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e)) from None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m archimap.extract", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video", type=Path)
    p.add_argument("--zone", help="zone slug, used as the output folder name")
    p.add_argument("--name", help="human-readable zone name (defaults to the slug)")
    p.add_argument("--coords-box", type=parse_box, metavar="X,Y,W,H",
                   help="pixel area showing the [x,y] coordinates; OCR is skipped without it")
    p.add_argument("--view-box", type=parse_box, metavar="X,Y,W,H",
                   help="pixel area of the game view to keep in tiles (default: full frame)")
    p.add_argument("--start", type=parse_point, metavar="X,Y",
                   help="coordinates of the first map, used when OCR can't read it")
    p.add_argument("--fps", type=float, default=6.0, help="frame sampling rate (default 6)")
    p.add_argument("--data-dir", type=Path,
                   help="where zone folders are written (default: <repo>/web/public/data)")
    p.add_argument("--out-dir", type=Path, help="debug output folder (default: <repo>/out)")
    p.add_argument("--preview", type=float, metavar="SECONDS",
                   help="only save one frame with a pixel grid, to help choose the boxes")

    t = p.add_argument_group("transition detection")
    defaults = TransitionConfig()
    t.add_argument("--dark-mean", type=float, default=defaults.dark_mean)
    t.add_argument("--uniform-std", type=float, default=defaults.uniform_std)
    t.add_argument("--cut-diff", type=float, default=defaults.cut_diff)
    t.add_argument("--min-segment-frames", type=int, default=defaults.min_segment_frames)
    return p


def save_preview(video: Path, time: float, dest: Path,
                 boxes: list[tuple[Box, tuple[int, int, int]]]) -> None:
    """Save a frame with a labelled pixel grid and any configured boxes drawn."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    grab_frame(video, time, dest)
    image = cv2.imread(str(dest))
    h, w = image.shape[:2]
    for x in range(0, w, 50):
        thick = x % 100 == 0
        cv2.line(image, (x, 0), (x, h), (0, 255, 255) if thick else (0, 128, 128), 1)
        if thick:
            cv2.putText(image, str(x), (x + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    for y in range(0, h, 50):
        thick = y % 100 == 0
        cv2.line(image, (0, y), (w, y), (0, 255, 255) if thick else (0, 128, 128), 1)
        if thick:
            cv2.putText(image, str(y), (2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    for box, color in boxes:
        cv2.rectangle(image, (box.x, box.y), (box.x + box.w, box.y + box.h), color, 2)
    cv2.imwrite(str(dest), image)


def apply_ocr(visit: MapVisit) -> None:
    readings = [read_coords(c) for c in sample_evenly(visit.coord_crops, OCR_SAMPLES)]
    coords, confidence, text = vote(readings)
    visit.ocr_text = text
    if coords is not None:
        visit.coords, visit.source, visit.confidence = coords, "ocr", confidence


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.video.is_file():
        print(f"error: {args.video} not found", file=sys.stderr)
        return 2
    root = find_repo_root(Path.cwd())
    out_root = args.out_dir or root / "out"

    if args.preview is not None:
        dest = out_root / f"preview_{args.video.stem}.png"
        boxes = [(b, c) for b, c in ((args.coords_box, (0, 0, 255)),
                                     (args.view_box, (0, 255, 0))) if b]
        save_preview(args.video, args.preview, dest, boxes)
        print(f"Preview saved to {dest}")
        return 0

    if not args.zone:
        print("error: --zone is required", file=sys.stderr)
        return 2
    if args.coords_box is None:
        print("warning: no --coords-box given, OCR is skipped. "
              "Use --preview to find the coordinates area.", file=sys.stderr)

    info = probe(args.video)
    print(f"{args.video.name}: {info.width}x{info.height}, {info.duration:.0f}s, "
          f"sampling at {args.fps:g} fps")
    cfg = TransitionConfig(dark_mean=args.dark_mean, uniform_std=args.uniform_std,
                           cut_diff=args.cut_diff, min_segment_frames=args.min_segment_frames)

    visits: list[MapVisit] = []
    for visit in segment(iter_frames(args.video, args.fps), cfg,
                         args.view_box, args.coords_box):
        if args.coords_box:
            apply_ocr(visit)
        coords = f"[{visit.coords[0]},{visit.coords[1]}]" if visit.coords else "?"
        print(f"  map {visit.index:3d}  {visit.start_time:7.1f}s–{visit.end_time:7.1f}s  {coords}")
        visits.append(visit)

    if visits and visits[0].coords is None and args.start:
        visits[0].coords, visits[0].source, visits[0].confidence = args.start, "manual", 1.0
    fill_coordinates(visits)
    maps = dedupe(visits)

    data_dir = args.data_dir or root / "web" / "public" / "data"
    zone_json = export_zone(maps, args.zone, args.name or args.zone,
                            args.video.name, data_dir)
    report = write_report(visits, maps, args.zone, args.video.name, out_root / args.zone)

    by_source = {s: sum(1 for m in maps if m.source == s) for s in ("ocr", "inferred", "manual")}
    unplaced = sum(1 for v in visits if v.coords is None)
    print(f"\n{len(visits)} visits → {len(maps)} unique maps "
          f"(OCR {by_source['ocr']}, inferred {by_source['inferred']}, "
          f"manual {by_source['manual']}), {unplaced} unplaced")
    print(f"Zone data: {zone_json}")
    print(f"Report:    {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
