import { expect, test } from "bun:test";
import { binarize, OCR_HEIGHT, parseCoords, readingValue, repairReading, tally } from "./ocr";

test("parse coordinates", () => {
  expect(parseCoords("-26,-57")).toEqual([-26, -57]);
  expect(parseCoords("[ 12 , -3 ]")).toEqual([12, -3]);
  expect(parseCoords("−5,12")).toEqual([-5, 12]);
  expect(parseCoords("-26")).toBeNull();
  expect(parseCoords("999,1")).toBeNull();
});

test("tally shares", () => {
  expect(tally([[1, 2], [1, 2], [3, 4], null])).toEqual([
    { coords: [1, 2], share: 0.5 },
    { coords: [3, 4], share: 0.25 },
  ]);
});

test("disagreeing readings resolve toward the current position", () => {
  expect(readingValue([[-27, -55], [-27, -95]], [-28, -55])).toEqual([-27, -55]);
  expect(readingValue([[-27, -55], [-27, -95]], null)).toBeNull();
  expect(readingValue([[-27, -55], null], [0, 0])).toEqual([-27, -55]);
  expect(readingValue([null, null], [0, 0])).toBeNull();
  // No current position yet: the zone's map list breaks the tie.
  expect(readingValue([[-26, -37], [-26, -57]], null, new Set(["-26,-57", "-26,-56"]))).toEqual([-26, -57]);
});

test("binarize gives dark text on white at the OCR height", () => {
  // 20x10 crop: dark background with a white vertical bar in the middle.
  const w = 20, h = 10;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x >= 8 && x < 12 ? 250 : 40;
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  const out = binarize({ width: w, height: h, data }, 160, 0);
  expect(out.height).toBe(OCR_HEIGHT + 40);
  const at = (x: number, y: number) => out.data[(y * out.width + x) * 4];
  const mid = 20 + OCR_HEIGHT / 2;
  expect(at(20 + Math.round(10 * 13.6), mid)).toBe(0); // bar centre: text
  expect(at(25, mid)).toBe(255); // background
  expect(at(5, 5)).toBe(255); // padding
  const thick = binarize({ width: w, height: h, data }, 160, 3);
  const darkCount = (img: typeof out) => img.data.filter((v, i) => i % 4 === 0 && v === 0).length;
  expect(darkCount(thick)).toBeGreaterThan(darkCount(out));
});


test("readings one OCR slip away from a map next to the player are repaired", () => {
  const forest = new Set(["-5,17", "-5,18", "-5,19", "-6,18", "-7,17", "-7,18"]);
  // A light ray read as a 1 (Forêt maléfique [-5,18]).
  expect(repairReading([-5, 118], [-5, 17], forest)).toEqual([-5, 18]);
  // The minus sign lost ([-7,17]).
  expect(repairReading([7, 17], [-7, 18], forest)).toEqual([-7, 17]);
  // Already a map of the zones, or next to the player: as read.
  expect(repairReading([-5, 19], [-5, 18], forest)).toEqual([-5, 19]);
  expect(repairReading([7, 17], [7, 18], forest)).toEqual([7, 17]); // on the surface, next to the player
  // Far from the player, or no position yet: as read.
  expect(repairReading([-5, 118], [-20, 30], forest)).toEqual([-5, 118]);
  expect(repairReading([-5, 118], null, forest)).toEqual([-5, 118]);
  // Applied to a capture's readings.
  expect(readingValue([[-5, 118], [-5, 18]], [-5, 17], forest)).toEqual([-5, 18]);
  expect(readingValue([[7, 17], [7, 17]], [-7, 18], forest)).toEqual([-7, 17]);
});
