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

/** Edits (insert, delete, replace a character) between two strings. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export interface Surroundings {
  /** Map keys of every zone. */
  zoneMaps: ReadonlySet<string>;
  /** Maps a passage leads to from each map, as keys (both ways). */
  neighbours: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Where the player can be one move from the current map: there, or a map a passage leads to. */
function reachable(current: Coords, { zoneMaps, neighbours }: Surroundings): string[] {
  const key = coordsKey(current);
  const linked = neighbours.get(key);
  if (linked) return [key, ...linked];
  // Off the zones' passages (on the surface): the zone maps next to it.
  const [x, y] = current;
  return [key, ...([[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as Coords[]).map(coordsKey).filter((k) => zoneMaps.has(k))];
}

/**
 * The map one OCR text names. The player walks one map at a time, so the
 * text is matched against the maps reachable from the current one: the
 * closest within two character slips wins ("-5,118" for -5,18 with a light
 * ray read as a 1, "7,17" for -7,17, "-117" for -1,17). A map of the zones
 * read exactly, or coordinates next to the player (out on the surface),
 * stand as read. Otherwise, or with no position yet, the coordinates read.
 */
export function decodeText(text: string, current: Coords | null, around: Surroundings): Coords | null {
  const read = parseCoords(text);
  if (!current) return read;
  const candidates = new Set(reachable(current, around));
  if (read && (around.zoneMaps.has(coordsKey(read)) || isAdjacent(read, current))) candidates.add(coordsKey(read));
  const clean = text.replace(/[−–—]/g, "-").replace(/\s+/g, "");
  const scored = [...candidates]
    .map((key) => ({ key, d: editDistance(clean, key) }))
    .sort((a, b) => a.d - b.d);
  const [best, second] = scored;
  const limit = best && best.key.length >= 4 ? 2 : 1;
  // Only when there's no doubt about which.
  if (best && best.d <= limit && (!second || second.d > best.d)) return best.key.split(",").map(Number) as Coords;
  return read;
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
