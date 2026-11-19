// Port of pipeline/archimap/layout.py: find the game area and the
// coordinates text at any capture size (modern UI scales evenly).
import { mean, median, resizeArea, type Box, type GrayImage } from "./image";

/** An interface border must be this many times stronger than a typical edge. */
const EDGE_RATIO = 10;
/** Region searched for the "Coordonnées : x, y" label, as fractions of the game area. */
export const LABEL_REGION = { w: 0.35, h: 0.15 };
/** Where the numbers are when the label can't be found, as fractions of the game area. */
const DEFAULT_COORDS = { x: 0.1276, y: 0.0693, w: 0.1094, h: 0.0406 };
/** Label pixels brighter than this in every channel count as white text. */
export const LABEL_THRESHOLD = 185;
/** Columns are grouped this wide when storing row edges, to keep frames small in memory. */
const ROW_BLOCK = 16;

/** What layout detection keeps from one captured frame (not the frame itself). */
export interface FrameEdges {
  width: number;
  height: number;
  /** 64x36 thumbnail, to tell different maps apart and spot loading frames. */
  small: Float32Array;
  /** Edge strength between each pair of columns. */
  cols: Float32Array;
  /** Edge strength between each pair of rows, summed per ROW_BLOCK-wide column block. */
  rowBlocks: Float32Array;
}

export function frameEdges(gray: GrayImage): FrameEdges {
  const { width: w, height: h, data } = gray;
  const cols = new Float32Array(w - 1);
  const blocks = Math.ceil(w / ROW_BLOCK);
  const rowBlocks = new Float32Array((h - 1) * blocks);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w - 1; x++) cols[x] += Math.abs(data[row + x + 1] - data[row + x]);
    if (y < h - 1) {
      for (let x = 0; x < w; x++) {
        rowBlocks[y * blocks + Math.floor(x / ROW_BLOCK)] += Math.abs(data[row + w + x] - data[row + x]);
      }
    }
  }
  for (let x = 0; x < cols.length; x++) cols[x] /= h;
  return { width: w, height: h, small: resizeArea(gray, 64, 36).data, cols, rowBlocks };
}

export function isLoadingFrame(frame: Pick<FrameEdges, "small">): boolean {
  return mean(frame.small) < 25;
}

/** Mean grey-level difference between two thumbnails of the same size. */
export function viewDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return a.length ? diff / a.length : 0;
}

/**
 * Whether the game view shows another map: most of it changed, not a part
 * (a window opened over it, a fight's overlay, a monster group walking by).
 * Stairs between landings keep the coordinates but change the whole picture.
 */
export function isOtherScene(a: ArrayLike<number>, b: ArrayLike<number>, minFraction = 0.6): boolean {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 30) changed++;
  return changed >= minFraction * a.length;
}

/** True if the frame shows a clearly different picture from all the others. */
export function isDistinct(frame: FrameEdges, others: FrameEdges[], minDiff = 15): boolean {
  return others.every((o) => {
    let diff = 0;
    for (let i = 0; i < frame.small.length; i++) diff += Math.abs(frame.small[i] - o.small[i]);
    return diff / frame.small.length >= minDiff;
  });
}

function medianProfile(profiles: Float32Array[]): number[] {
  return Array.from(profiles[0], (_, i) => median(profiles.map((p) => p[i])));
}

/** Position of the strongest border in profile[lo:hi], or null. */
export function findBorder(profile: number[], lo: number, hi: number): number | null {
  if (hi <= lo) return null;
  let peak = lo;
  for (let i = lo; i < hi; i++) if (profile[i] > profile[peak]) peak = i;
  // Floor the baseline: flat images have a typical edge strength of ~0.
  if (profile[peak] < EDGE_RATIO * Math.max(median(profile), 1)) return null;
  // A border is a few pixels wide with an edge on each side: keep its first one.
  const window = Math.max(2, Math.floor(profile.length / 200));
  for (let i = Math.max(lo, peak - window); i <= peak; i++) {
    if (profile[i] > 0.3 * profile[peak]) return i + 1;
  }
  return peak + 1;
}

/**
 * The game view: left of the chat panel and above the UI bar, if present.
 * Uses the median over frames of different maps, since map content changes
 * between them but interface borders don't.
 */
export function detectGameArea(frames: FrameEdges[]): Box {
  const { width: w, height: h } = frames[0];
  // Skip the last pixels: captures often have a 1px edge artefact there.
  const right = findBorder(medianProfile(frames.map((f) => f.cols)), w >> 1, w - 3) ?? w;
  const blocks = Math.ceil(w / ROW_BLOCK);
  const used = Math.max(1, Math.floor(right / ROW_BLOCK));
  const rows = frames.map((f) => {
    const out = new Float32Array(h - 1);
    for (let y = 0; y < h - 1; y++) {
      let sum = 0;
      for (let b = 0; b < used; b++) sum += f.rowBlocks[y * blocks + b];
      out[y] = sum / (used * ROW_BLOCK);
    }
    return out;
  });
  const bottom = findBorder(medianProfile(rows), h >> 1, h - 3) ?? h;
  return { x: 0, y: 0, w: right, h: bottom };
}

export function defaultCoordsBox(game: Box): Box {
  return {
    x: game.x + Math.round(game.w * DEFAULT_COORDS.x),
    y: game.y + Math.round(game.h * DEFAULT_COORDS.y),
    w: Math.round(game.w * DEFAULT_COORDS.w),
    h: Math.round(game.h * DEFAULT_COORDS.h),
  };
}

export function labelRegion(game: Box): Box {
  return { x: game.x, y: game.y, w: Math.round(game.w * LABEL_REGION.w), h: Math.round(game.h * LABEL_REGION.h) };
}

/** Upscale applied to the label region before OCR, to the text size this was tuned on. */
export function labelScale(game: Box): number {
  return (2 * 837) / game.h;
}

export interface OcrWord {
  text: string;
  /** In the scaled label-region image. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Box around the numbers after the "Coordonnées :" label, from OCR'd words. */
export function coordsBoxFromLabel(words: OcrWord[], region: Box, scale: number): Box | null {
  const boxes = words.map((w) => ({
    text: w.text.trim(),
    left: w.bbox.x0 / scale,
    top: w.bbox.y0 / scale,
    width: (w.bbox.x1 - w.bbox.x0) / scale,
    height: (w.bbox.y1 - w.bbox.y0) / scale,
  }));
  // Tolerant to misreads such as "Coaordonnées" or "Cordonnees".
  const i = boxes.findIndex((b) => b.text.length >= 7 && b.text.toLowerCase().includes("ord"));
  if (i < 0) return null;
  const label = boxes[i];
  let start = label.left + label.width + 0.08 * label.width;
  const colon = boxes.slice(i + 1, i + 3).find((b) => b.text.startsWith(":") && Math.abs(b.top - label.top) < label.height);
  if (colon) start = colon.left + colon.width;
  return {
    x: region.x + Math.round(start + 0.03 * label.width),
    y: region.y + Math.round(label.top - 0.5 * label.height),
    w: Math.round(1.15 * label.width),
    h: Math.round(2 * label.height),
  };
}
