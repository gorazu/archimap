import { expect, test } from "bun:test";
import { planShapes } from "./plan";
import type { Zone } from "./zones";

const zone = (extra: Partial<Zone>): Zone => ({
  zone: "z", name: "z", source_video: null, tile_size: [100, 100],
  maps: [{ x: 0, y: 0, source: "client" }, { x: 1, y: 0, source: "client" }],
  ...extra,
});

test("without map files: centre nodes and straight connections", () => {
  const shapes = planShapes(zone({ links: [[0, 0, 1, 0]] }));
  expect(shapes.nodes).toEqual([[-50, 50], [-50, 150]]);
  expect(shapes.routes).toEqual([]);
  expect(shapes.crossings).toEqual([[[-50, 50], [-50, 150]]]);
});

test("routes follow the floor and crossings join the suns", () => {
  const shapes = planShapes(zone({
    maps: [
      { x: 0, y: 0, source: "client", areas: [[0.5, 0.5]], paths: [[[0.1, 0.5], [0.5, 0.2], [0.95, 0.5]]] },
      { x: 1, y: 0, source: "client", areas: [[0.5, 0.5]], paths: [[[0.05, 0.4], [0.5, 0.9]]] },
    ],
    links: [[0, 0, 1, 0]],
    passages: [{ a: [0, 0, 0], b: [1, 0, 0], t: 0.45, ua: [0.95, 0.5], ub: [0.05, 0.4] }],
  }));
  expect(shapes.nodes).toEqual([]);
  expect(shapes.routes).toEqual([[[-50, 10], [-20, 50], [-50, 95]], [[-40, 105], [-90, 150]]]);
  expect(shapes.crossings).toEqual([[[-50, 95], [-40, 105]]]); // no extra straight line for that link
});
