import { expect, test } from "bun:test";
import { binarize, decodeText, OCR_HEIGHT, parseCoords, readingValue, tally } from "./ocr";

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


test("texts are matched to the maps reachable from the player's", () => {
  // Forêt maléfique, around [-5,18], [-7,17], [-1,17] and the [0,22] dead end.
  const zoneMaps = new Set(["-5,17", "-5,18", "-5,19", "-6,18", "-7,17", "-7,18", "-1,17", "-1,18", "0,21", "0,22"]);
  const neighbours = new Map<string, Set<string>>([
    ["-5,17", new Set(["-5,18"])],
    ["-5,18", new Set(["-5,17", "-5,19", "-6,18"])],
    ["-7,18", new Set(["-7,17"])],
    ["-1,18", new Set(["-1,17"])],
    ["0,21", new Set(["0,22"])],
    ["0,22", new Set(["0,21"])],
  ]);
  const around = { zoneMaps, neighbours };
  // A light ray read as a 1, a minus sign, a comma or a digit lost.
  expect(decodeText("-5,118", [-5, 17], around)).toEqual([-5, 18]);
  expect(decodeText("7,17", [-7, 18], around)).toEqual([-7, 17]);
  expect(decodeText("-117", [-1, 18], around)).toEqual([-1, 17]);
  expect(decodeText("0,222", [0, 21], around)).toEqual([0, 22]);
  // Two reachable maps as close: as read.
  expect(decodeText("-1,11", [-1, 18], around)).toEqual([-1, 11]);
  expect(decodeText("0,2", [0, 21], around)).toEqual([0, 2]);
  // A zone map read exactly, or the surface next to the player: as read.
  expect(decodeText("-5,19", [-5, 18], around)).toEqual([-5, 19]);
  expect(decodeText("-5,17", [-5, 18], around)).toEqual([-5, 17]);
  expect(decodeText("7,17", [7, 18], around)).toEqual([7, 17]);
  // Far from anything reachable, or no position yet: as read.
  expect(decodeText("4,-18", [-5, 18], around)).toEqual([4, -18]);
  expect(decodeText("-5,118", null, around)).toEqual([-5, 118]);
  // Off the passages: the zone maps next to the player.
  expect(decodeText("-5,118", [-4, 18], around)).toEqual([-5, 18]);
});
