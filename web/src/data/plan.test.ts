import { expect, test } from "bun:test";
import { planShapes } from "./plan";
import type { Zone } from "./zones";

const zone = (extra: Partial<Zone>): Zone => ({
  zone: "z", name: "z", source_video: null, tile_size: [100, 100],
  maps: [{ x: 0, y: 0, source: "client" }, { x: 1, y: 0, source: "client" }],
  ...extra,
});

test("without area data: tile centres and straight corridors", () => {
  const shapes = planShapes(zone({ links: [[0, 0, 1, 0]] }));
  expect(shapes.nodes).toEqual([[-50, 50], [-50, 150]]);
  expect(shapes.bands).toHaveLength(1);
  expect(shapes.joints).toEqual([]);
});

test("split maps: a node per area and a corridor per path", () => {
  const shapes = planShapes(zone({
    maps: [
      { x: 0, y: 0, source: "client", areas: [[0.5, 0.2], [0.5, 0.8]] },
      { x: 1, y: 0, source: "client", areas: [[0.5, 0.5]] },
    ],
    links: [[0, 0, 1, 0]],
    // Two separate paths from the two parts of [0,0] into [1,0].
    passages: [{ a: [0, 0, 0], b: [1, 0, 0], t: 0.2 }, { a: [0, 0, 1], b: [1, 0, 0], t: 0.8 }],
  }));
  expect(shapes.nodes).toEqual([[-20, 50], [-80, 50], [-50, 150]]);
  expect(shapes.joints).toEqual([[-20, 100], [-80, 100]]);
  expect(shapes.bands).toHaveLength(4); // two pieces per path, no straight fallback
});


test("unsplit maps keep centre nodes and straight corridors", () => {
  const shapes = planShapes(zone({
    maps: [
      { x: 0, y: 0, source: "client", areas: [[0.9, 0.1]] },
      { x: 1, y: 0, source: "client", areas: [[0.1, 0.9]] },
    ],
    links: [[0, 0, 1, 0]],
    passages: [{ a: [0, 0, 0], b: [1, 0, 0], t: 0.3 }],
  }));
  expect(shapes.nodes).toEqual([[-50, 50], [-50, 150]]);
  expect(shapes.joints).toEqual([]);
  expect(shapes.bands).toHaveLength(1);
});
