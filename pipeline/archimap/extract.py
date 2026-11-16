"""CLI: turn a gameplay video into zone map data.

    python -m archimap.extract video.mp4 --zone zone-slug [--coords-box x,y,w,h] [--fps 6]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from .client_zones import build_zone, find_client_data, load_client_data
from .corrections import apply_link_corrections, corrections_path
from .dedupe import dedupe
from .export import export_zone, update_zone_index
from .frames import grab_frame, iter_frames, iter_keyframes, probe
from .infer import fill_coordinates, place_between_neighbours, resolve_with_route, route_links
from .layout import detect_layout, distinct_frames
from .models import Box, MapVisit
from .ocr import TEXT_VARIANTS, OcrReading, read_coords_many, sample_evenly, tally, vote
from .report import write_report
from .transitions import TransitionConfig, segment

OCR_SAMPLES = 7
LAYOUT_FRAMES = 12


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
                   help="pixel area showing the coordinates numbers "
                        "(default: found from the \"Coordonnées\" label)")
    p.add_argument("--view-box", type=parse_box, metavar="X,Y,W,H",
                   help="pixel area of the game view to keep in tiles "
                        "(default: detected from the chat panel and UI bar borders)")
    p.add_argument("--start", type=parse_point, metavar="X,Y",
                   help="coordinates of the first map, used when OCR can't read it")
    p.add_argument("--fps", type=float, default=10.0, help="frame sampling rate (default 10)")
    p.add_argument("--text-threshold", type=int, metavar="0-255",
                   help="read coordinates with this single fixed brightness threshold "
                        "instead of the default pair tuned for any capture size")
    p.add_argument("--data-dir", type=Path,
                   help="where zone folders are written (default: <repo>/web/public/data)")
    p.add_argument("--out-dir", type=Path, help="debug output folder (default: <repo>/out)")
    p.add_argument("--preview", type=float, metavar="SECONDS",
                   help="only save one frame with a pixel grid and the boxes that would be used")

    t = p.add_argument_group("transition detection")
    defaults = TransitionConfig()
    t.add_argument("--dark-mean", type=float, default=defaults.dark_mean)
    t.add_argument("--uniform-std", type=float, default=defaults.uniform_std)
    t.add_argument("--dip-ratio", type=float, default=defaults.dip_ratio)
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


def resolve_boxes(args: argparse.Namespace) -> tuple[Box, Box]:
    """Use the boxes given on the command line, detect the missing ones."""
    if args.view_box and args.coords_box:
        return args.view_box, args.coords_box
    # Frames of different maps spread over the video, for the median-based detection.
    layout = detect_layout(distinct_frames(iter_keyframes(args.video), LAYOUT_FRAMES),
                           game=args.view_box)
    view, coords = args.view_box or layout.game, args.coords_box or layout.coords
    if not args.view_box:
        print(f"  game area {view.x},{view.y},{view.w},{view.h} (detected)")
    if not args.coords_box:
        how = "found from the label" if layout.coords_found else \
            "label not found, default position: check the report"
        print(f"  coordinates {coords.x},{coords.y},{coords.w},{coords.h} ({how})")
    return view, coords


def apply_ocr(visit: MapVisit, readings: list[OcrReading]) -> None:
    coords, confidence, text = vote(readings)
    visit.ocr_text = text
    visit.ocr_texts = [r.text for r in readings]
    visit.candidates = tally(readings)
    if coords is not None:
        visit.coords, visit.source, visit.confidence = coords, "ocr", confidence


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.video.is_file():
        print(f"error: {args.video} not found", file=sys.stderr)
        return 2
    root = find_repo_root(Path.cwd())
    out_root = args.out_dir or root / "out"

    if args.preview is None and not args.zone:
        print("error: --zone is required", file=sys.stderr)
        return 2

    info = probe(args.video)
    print(f"{args.video.name}: {info.width}x{info.height}, {info.duration:.0f}s")
    view_box, coords_box = resolve_boxes(args)

    if args.preview is not None:
        dest = out_root / f"preview_{args.video.stem}.png"
        save_preview(args.video, args.preview, dest,
                     [(coords_box, (0, 0, 255)), (view_box, (0, 255, 0))])
        print(f"Preview saved to {dest}")
        return 0

    print(f"Sampling at {args.fps:g} fps")
    variants = ((args.text_threshold, 3),) if args.text_threshold else TEXT_VARIANTS
    cfg = TransitionConfig(dark_mean=args.dark_mean, uniform_std=args.uniform_std,
                           dip_ratio=args.dip_ratio,
                           cut_diff=args.cut_diff, min_segment_frames=args.min_segment_frames)

    visits: list[MapVisit] = []
    for visit in segment(iter_frames(args.video, args.fps), cfg, view_box, coords_box):
        visits.append(visit)
        print(f"\r  reading the video: {visit.end_time:.0f}s / {info.duration:.0f}s",
              end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    # All coordinates at once: batched Tesseract runs are much faster.
    samples = [sample_evenly(v.coord_crops, OCR_SAMPLES) for v in visits]
    readings = read_coords_many([c for crops in samples for c in crops], variants)
    for visit, crops in zip(visits, samples):
        apply_ocr(visit, [r for rs in readings[:len(crops)] for r in rs])
        readings = readings[len(crops):]
        coords = f"[{visit.coords[0]},{visit.coords[1]}]" if visit.coords else "?"
        print(f"  map {visit.index:3d}  {visit.start_time:7.1f}s–{visit.end_time:7.1f}s  {coords}")

    if visits and visits[0].coords is None and args.start:
        visits[0].coords, visits[0].source, visits[0].confidence = args.start, "manual", 1.0
    read = [v.coords for v in visits]
    resolve_with_route(visits)
    for visit, before in zip(visits, read):
        if visit.coords != before:
            print(f"  map {visit.index:3d}  OCR read [{before[0]},{before[1]}], next to the "
                  f"neighbouring maps: [{visit.coords[0]},{visit.coords[1]}]")
    for visit in place_between_neighbours(visits):
        print(f"  map {visit.index:3d}  OCR unreliable, placed between its neighbours: "
              f"[{visit.coords[0]},{visit.coords[1]}] (check it on the map)")
    fill_coordinates(visits)
    maps = dedupe(visits)

    data_dir = args.data_dir or root / "web" / "public" / "data"
    name = args.name or args.zone
    links, notes = apply_link_corrections(route_links(visits), corrections_path(root, args.zone),
                                          {m.coords for m in maps})
    for note in notes:
        print(f"  {note}")
    zone_json = export_zone(maps, args.zone, name, args.video.name, data_dir,
                            links=links)
    count = len(maps)
    config_path = corrections_path(root, args.zone)
    config = json.loads(config_path.read_text()) if config_path.is_file() else {}
    if "client_subarea" in config:
        # Keep the maps the recording missed, from the game client's data.
        client = find_client_data()
        if client is None:
            print("  warning: game client data not found, maps missing from the recording are not added")
        else:
            zone, notes = build_zone(args.zone, config, load_client_data(client),
                                     json.loads(zone_json.read_text()), config_path)
            zone_json.write_text(json.dumps(zone, indent=2, ensure_ascii=False) + "\n")
            name, count = zone["name"], len(zone["maps"])
            print(f"  client data: {'; '.join(notes)}")
    update_zone_index(data_dir, args.zone, name, count)
    report = write_report(visits, maps, args.zone, args.video.name, out_root / args.zone,
                          variants[0])

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
