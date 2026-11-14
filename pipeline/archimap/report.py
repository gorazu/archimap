"""HTML debug report for reviewing a pipeline run."""

from __future__ import annotations

import html
import shutil
from pathlib import Path

import cv2

from .models import MapVisit
from .ocr import preprocess

PREVIEW_WIDTH = 320


def _save(image, path: Path, width: int | None = None) -> None:
    if width and image.shape[1] > width:
        h = round(image.shape[0] * width / image.shape[1])
        image = cv2.resize(image, (width, h), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(path), image)


def _fmt_time(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def write_report(visits: list[MapVisit], kept: list[MapVisit], zone: str,
                 video: str, out_dir: Path) -> Path:
    assets = out_dir / "assets"
    shutil.rmtree(assets, ignore_errors=True)
    assets.mkdir(parents=True)
    kept_ids = {id(v) for v in kept}

    rows = []
    for v in visits:
        _save(v.image, assets / f"visit_{v.index}.jpg", PREVIEW_WIDTH)
        crop_cells = "<td>—</td><td>—</td>"
        if v.coord_crops:
            _save(v.coord_crops[0], assets / f"coords_{v.index}.png")
            _save(preprocess(v.coord_crops[0]), assets / f"coords_{v.index}_bin.png")
            crop_cells = (f'<td><img class="crop" src="assets/coords_{v.index}.png"></td>'
                          f'<td><img class="crop" src="assets/coords_{v.index}_bin.png"></td>')
        coords = f"[{v.coords[0]},{v.coords[1]}]" if v.coords else "—"
        if v.coords is None:
            status, cls = "unplaced", "bad"
        elif id(v) in kept_ids:
            status, cls = "kept", "ok" if v.source == "ocr" else "warn"
        else:
            status, cls = "duplicate", "dup"
        rows.append(f"""<tr class="{cls}">
  <td>{v.index}</td>
  <td>{_fmt_time(v.start_time)}–{_fmt_time(v.end_time)}<br><small>best {_fmt_time(v.video_time)}</small></td>
  <td><img class="preview" src="assets/visit_{v.index}.jpg"></td>
  {crop_cells}
  <td><code>{html.escape(v.ocr_text) or "—"}</code></td>
  <td><b>{coords}</b></td>
  <td>{v.source or "—"}<br><small>conf {v.confidence:.2f}</small></td>
  <td>{v.exit_side or "?"}<br><small>{v.exit_score:.2f}</small></td>
  <td>{status}</td>
</tr>""")

    grid = ""
    if kept:
        xs = [v.coords[0] for v in kept]
        ys = [v.coords[1] for v in kept]
        min_x, min_y = min(xs), min(ys)
        cells = []
        for v in kept:
            x, y = v.coords
            cells.append(
                f'<div class="cell {v.source}" style="grid-column:{x - min_x + 1};'
                f'grid-row:{y - min_y + 1}"><img src="assets/visit_{v.index}.jpg">'
                f"<span>{x},{y}</span></div>")
        grid = (f'<div class="grid" style="grid-template-columns:repeat({max(xs) - min_x + 1},120px)">'
                + "".join(cells) + "</div>")

    counts = {s: sum(1 for v in kept if v.source == s) for s in ("ocr", "inferred", "manual")}
    unplaced = sum(1 for v in visits if v.coords is None)
    page = f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Archimap report — {html.escape(zone)}</title>
<style>
body {{ font: 14px system-ui, sans-serif; margin: 24px; background: #f6f6f4; color: #222; }}
table {{ border-collapse: collapse; background: #fff; }}
td, th {{ border: 1px solid #ddd; padding: 6px; vertical-align: middle; text-align: left; }}
tr.ok td:last-child {{ background: #d9f2d9; }}
tr.warn td:last-child {{ background: #fff1c2; }}
tr.bad td:last-child {{ background: #f8d0d0; }}
tr.dup {{ opacity: .55; }}
.preview {{ width: 200px; display: block; }}
.crop {{ max-width: 200px; image-rendering: pixelated; }}
.grid {{ display: grid; gap: 2px; grid-auto-rows: auto; margin-bottom: 32px; }}
.cell {{ position: relative; border: 2px solid #4a4; }}
.cell.inferred {{ border-color: #d90; }}
.cell.manual {{ border-color: #46c; }}
.cell img {{ width: 100%; display: block; }}
.cell span {{ position: absolute; left: 2px; top: 2px; background: #000a; color: #fff; padding: 0 4px; font-size: 12px; }}
</style></head><body>
<h1>{html.escape(zone)}</h1>
<p>Video: <code>{html.escape(video)}</code> · {len(visits)} visits · {len(kept)} unique maps
(OCR {counts["ocr"]}, inferred {counts["inferred"]}, manual {counts["manual"]}) · {unplaced} unplaced</p>
<h2>Assembled map</h2>
<p>Green border: OCR · orange: inferred (check these) · blue: manual.</p>
{grid or "<p>No placed maps.</p>"}
<h2>Visits</h2>
<table>
<tr><th>#</th><th>Time</th><th>Best frame</th><th>Coords crop</th><th>OCR input</th><th>OCR text</th><th>Coords</th><th>Source</th><th>Exit</th><th>Status</th></tr>
{"".join(rows)}
</table>
</body></html>
"""
    path = out_dir / "report.html"
    path.write_text(page)
    return path
