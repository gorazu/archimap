import { describe, expect, test } from "bun:test";
import type { GrayImage } from "./image";
import { coordsBoxFromLabel, defaultCoordsBox, detectGameArea, frameEdges, isDistinct, isLoadingFrame } from "./layout";

/** Fake window: detailed map top-left, chat panel right, UI bar below, 2px borders. */
function windowFrame(seed: number, w: number, h: number, gw: number, gh: number): GrayImage {
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const data = new Float32Array(w * h);
  // Map content differs between frames: block grids that don't line up.
  const block = [5, 7, 9, 11, 13][seed % 5];
  const off = (seed * 3) % block;
  const cells = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v: number;
      if (x >= gw && x < gw + 2) v = 230;
      else if (x >= gw) v = 30 + (y % 18 === 0 && x < gw + 40 + (seed * 13) % 100 ? 150 : 0);
      else if (y >= gh && y < gh + 2) v = 240;
      else if (y >= gh) v = 190;
      else {
        const key = Math.floor((y + off) / block) * 10000 + Math.floor((x + off) / block);
        if (!cells.has(key)) cells.set(key, 20 + rand() * 100);
        v = cells.get(key)! + (rand() - 0.5) * 16; // fine detail, like real maps
      }
      data[y * w + x] = v;
    }
  }
  return { width: w, height: h, data };
}

describe("game area", () => {
  for (const [w, h] of [[480, 270], [960, 540]]) {
    test(`detected at ${w}x${h}`, () => {
      const gw = Math.round(w * 0.714);
      const gh = Math.round(h * 0.777);
      const frames = [1, 2, 3, 4, 5].map((seed) => frameEdges(windowFrame(seed, w, h, gw, gh)));
      const game = detectGameArea(frames);
      expect(Math.abs(game.w - gw)).toBeLessThanOrEqual(2);
      expect(Math.abs(game.h - gh)).toBeLessThanOrEqual(2);
    });
  }

  test("game-only capture is the full frame", () => {
    const frames = [1, 2, 3, 4, 5].map((seed) => frameEdges(windowFrame(seed, 320, 180, 320, 180)));
    expect(detectGameArea(frames)).toEqual({ x: 0, y: 0, w: 320, h: 180 });
  });

  test("distinct and loading frames", () => {
    const a = frameEdges(windowFrame(1, 320, 180, 230, 140));
    // A clearly different picture: a left-to-right gradient.
    const b = frameEdges({ width: 320, height: 180, data: Float32Array.from({ length: 320 * 180 }, (_, i) => (i % 320) * 0.8) });
    const dark = frameEdges({ width: 320, height: 180, data: new Float32Array(320 * 180) });
    expect(isLoadingFrame(dark)).toBe(true);
    expect(isLoadingFrame(a)).toBe(false);
    expect(isDistinct(a, [a])).toBe(false);
    expect(isDistinct(b, [a, dark])).toBe(true);
  });
});

test("default coordinates box scales with the game area", () => {
  expect(defaultCoordsBox({ x: 0, y: 0, w: 1371, h: 837 })).toEqual({ x: 175, y: 58, w: 150, h: 34 });
});

test("coordinates box from the label words", () => {
  // Word boxes as Tesseract returns them on the x2 label region of a 1371x837 game area.
  const words = [
    { text: "Coaordonnées", bbox: { x0: 48, y0: 134, x1: 310, y1: 168 } },
    { text: ":", bbox: { x0: 334, y0: 144, x1: 338, y1: 166 } },
    { text: "-26,", bbox: { x0: 362, y0: 136, x1: 440, y1: 174 } },
  ];
  expect(coordsBoxFromLabel(words, { x: 0, y: 0, w: 480, h: 126 }, 2)).toEqual({ x: 173, y: 59, w: 151, h: 34 });
  expect(coordsBoxFromLabel([{ text: "Bonta", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }], { x: 0, y: 0, w: 1, h: 1 }, 1)).toBeNull();
});
