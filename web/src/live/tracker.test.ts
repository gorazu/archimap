import { expect, test } from "bun:test";
import { PositionTracker } from "./tracker";

test("confirms the first position after stable reads", () => {
  const t = new PositionTracker({ stableReads: 3, jumpReads: 6 });
  expect(t.push([0, 0])).toBeNull();
  expect(t.push([0, 0])).toBeNull();
  expect(t.push([0, 0])).toEqual([0, 0]);
  expect(t.push([0, 0])).toBeNull(); // already current
});

test("unreadable frames don't break a streak, a different reading does", () => {
  const t = new PositionTracker({ stableReads: 3, jumpReads: 6 });
  t.push([0, 0]);
  t.push(null);
  t.push([0, 0]);
  expect(t.push([0, 0])).toEqual([0, 0]);
  t.push([1, 0]);
  t.push([1, 0]);
  t.push([5, 5]);
  expect(t.push([1, 0])).toBeNull();
});

test("jumps to non-adjacent maps need more reads", () => {
  const t = new PositionTracker({ stableReads: 2, jumpReads: 4 });
  t.push([0, 0]);
  t.push([0, 0]);
  expect(t.current).toEqual([0, 0]);
  for (let i = 0; i < 3; i++) expect(t.push([9, 9])).toBeNull();
  expect(t.push([9, 9])).toEqual([9, 9]);
  t.push([9, 10]);
  expect(t.push([9, 10])).toEqual([9, 10]); // adjacent: 2 reads
});
