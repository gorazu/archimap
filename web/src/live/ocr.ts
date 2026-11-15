// Port of pipeline/archimap/ocr.py: binarize the coordinates crop and vote.
import { minChannel, percentile, resizeBicubic, type RgbaImage } from "./image";

export type Coords = [number, number];

/**
 * Two binarizations that fail at different capture sizes: a fixed threshold,
 * and one relative to the brightest text pixels with thickened strokes.
 * A threshold below 1 is a fraction of the crop's 99th-percentile brightness.
 */
export const TEXT_VARIANTS: [threshold: number, thicken: number][] = [
  [160, 0],
  [0.7, 3],
];
/** Crops are resized to this height, so the text has the same size at any capture size. */
export const OCR_HEIGHT = 136;
const PADDING = 20;
const MAX_COORD = 150;

/** Dark text on white, resized to OCR_HEIGHT, as RGBA ready for a canvas. */
export function binarize(crop: RgbaImage, threshold: number, thicken: number): RgbaImage {
  const scale = OCR_HEIGHT / crop.height;
  // Bicubic like the pipeline (OpenCV): bilinear blurs small digits (5 read as 3 at 720p).
  const level = resizeBicubic(minChannel(crop), Math.max(1, Math.round(crop.width * scale)), OCR_HEIGHT);
  const cut = threshold < 1 ? threshold * percentile(level.data, 99) : threshold;
  const { width: w, height: h } = level;
  // 0 = text (black), 255 = background.
  let bin: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = level.data[i] > cut ? 0 : 255;
  if (thicken > 1) bin = erode(bin, w, h, thicken);
  const W = w + 2 * PADDING;
  const H = h + 2 * PADDING;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + PADDING) * W + x + PADDING) * 4;
      data[o] = data[o + 1] = data[o + 2] = bin[y * w + x];
    }
  }
  return { width: W, height: H, data };
}

/** Min filter: grows the black text by (size - 1) / 2 pixels. */
function erode(bin: Uint8Array, w: number, h: number, size: number): Uint8Array {
  const r = size >> 1;
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 255;
      for (let dy = -r; dy <= r && v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && bin[yy * w + xx] === 0) {
            v = 0;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export function parseCoords(text: string): Coords | null {
  const clean = text.replace(/[−–—]/g, "-").replace(/\s+/g, "");
  const match = /(-?\d{1,3}),(-?\d{1,3})/.exec(clean);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD ? null : [x, y];
}

export function coordsKey([x, y]: Coords): string {
  return `${x},${y}`;
}

export function isAdjacent(a: Coords, b: Coords): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

/** Share of all readings for each value read, most common first. */
export function tally(readings: (Coords | null)[]): { coords: Coords; share: number }[] {
  const counts = new Map<string, { coords: Coords; n: number }>();
  for (const r of readings) {
    if (!r) continue;
    const entry = counts.get(coordsKey(r)) ?? { coords: r, n: 0 };
    entry.n++;
    counts.set(coordsKey(r), entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map(({ coords, n }) => ({ coords, share: n / readings.length }));
}

/**
 * The value read from one capture (one reading per binarization). When the
 * readings disagree, prefer the one next to the current position (walking
 * moves one map at a time), then one that is a map of the zone; otherwise
 * the result is uncertain (null).
 */
export function readingValue(
  readings: (Coords | null)[],
  current: Coords | null,
  zoneMaps: ReadonlySet<string> = new Set(),
): Coords | null {
  const candidates = tally(readings);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].coords;
  if (current) {
    const near = candidates.find((c) => coordsKey(c.coords) === coordsKey(current) || isAdjacent(c.coords, current));
    if (near) return near.coords;
  }
  const inZone = candidates.filter((c) => zoneMaps.has(coordsKey(c.coords)));
  if (inZone.length === 1) return inZone[0].coords;
  return candidates[0].share > 0.5 ? candidates[0].coords : null;
}
