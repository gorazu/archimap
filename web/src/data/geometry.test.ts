import { expect, test } from "bun:test";
import { corridorBounds, tileBounds, tileCenter, tileWidth, zoneBounds } from "./geometry";

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

test("corridors join the centres of two maps", () => {
  expect(tileCenter(0, 0, [200, 100])).toEqual([-50, 100]);
  expect(corridorBounds([0, 0], [1, 0], [200, 100])).toEqual([[-59, 91], [-41, 309]]);
  expect(corridorBounds([0, 1], [0, 0], [200, 100])).toEqual([[-159, 91], [-41, 109]]);
});
