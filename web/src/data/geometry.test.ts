import { expect, test } from "bun:test";
import { tileBounds, tileWidth, zoneBounds } from "./geometry";

test("tile width keeps the aspect ratio", () => {
  expect(tileWidth([1280, 800])).toBe(160);
});

test("y grows downward: a larger y is lower on the map", () => {
  const upper = tileBounds(0, 0, [100, 100]);
  const lower = tileBounds(0, 1, [100, 100]);
  expect(lower[1][0]).toBeLessThan(upper[0][0]);
});

test("zone bounds cover every tile", () => {
  const maps = [{ x: -2, y: 3 }, { x: 1, y: 5 }];
  expect(zoneBounds(maps, [200, 100])).toEqual([[-600, -400], [-300, 400]]);
});
