import { expect, test } from "bun:test";
import { cellCount, cellPosition, decodeLayout, FLOOR, floorParts, SUN, WALL } from "./layout";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const pack = (values: number[]) => {
  const v = [...values, 0, 0].slice(0, Math.ceil(values.length / 3) * 3);
  let out = "";
  for (let i = 0; i < v.length; i += 3) out += ALPHABET[v[i] + 4 * v[i + 1] + 16 * v[i + 2]];
  return out;
};

test("decode matches the pipeline's packing", () => {
  const values = [WALL, SUN, FLOOR, FLOOR, WALL];
  expect([...decodeLayout({ w: 2, h: 2, cells: pack(values) })]).toEqual(values);
  expect(cellCount(15, 17)).toBe(479);
});

test("cell positions follow the staggered grid", () => {
  expect(cellPosition(0, 15)).toEqual([0, 0]);
  expect(cellPosition(14, 15)).toEqual([28, 0]);
  expect(cellPosition(15, 15)).toEqual([1, 1]);
  expect(cellPosition(29, 15)).toEqual([0, 2]);
});

test("a wall of cells splits the floor into parts", () => {
  // 3x3 map (13 cells): floor everywhere except a wall through the middle column.
  const w = 3;
  const values = new Uint8Array(cellCount(3, 3)).fill(FLOOR);
  values.forEach((_, id) => {
    const [x] = cellPosition(id, w);
    if (x >= 1 && x <= 3) values[id] = WALL;
  });
  const parts = floorParts(values, w);
  const left = parts[0]; // x = 0
  const right = parts[2]; // x = 4
  expect(left).not.toBe(-1);
  expect(right).not.toBe(-1);
  expect(left).not.toBe(right);
});
