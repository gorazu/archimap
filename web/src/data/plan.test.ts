import { expect, test } from "bun:test";
import { alongPaths, planShapes, routeShapes } from "./plan";
import { buildGraph, planRoute } from "./route";
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


test("a route is drawn from sun to sun and numbered in visiting order", () => {
  const z = zone({
    maps: [{ x: 0, y: 0, source: "client" }, { x: 1, y: 0, source: "client" }],
    links: [[0, 0, 1, 0]],
    passages: [{ a: [0, 0, 0], b: [1, 0, 0], t: 0.5, ua: [0.9, 0.5], ub: [0.1, 0.5] }],
  });
  const graph = buildGraph(z);
  const start = graph.nodes.findIndex((n) => n.map === "0,0");
  const route = planRoute(graph, new Set(["1,0"]), [start])!;
  const shapes = routeShapes(z, graph, route);
  expect(shapes.line.map((pt) => pt.map(Math.round))).toEqual([[-50, 50], [-50, 90], [-50, 110]]);
  expect(shapes.numbers.map((n) => [n.map, n.label])).toEqual([["0,0", "1"], ["1,0", "2"]]);
});


test("the walk inside a map follows its drawn paths", () => {
  // Paths as the pipeline draws them: a tree from the first sun, the second
  // path ending in the middle of the first one's stretch.
  const m = {
    x: 0, y: 0, source: "client" as const,
    paths: [
      [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]],
      [[0.7, 0.9], [0.7, 0.5]],
    ] as [number, number][][],
  };
  expect(alongPaths(m, [0.1, 0.5], [0.7, 0.9], [100, 100])).toEqual([[0.1, 0.5], [0.5, 0.5], [0.7, 0.5], [0.7, 0.9]]);
  expect(alongPaths(m, [0.9, 0.5], [0.7, 0.9], [100, 100])).toEqual([[0.9, 0.5], [0.7, 0.5], [0.7, 0.9]]);
  expect(alongPaths(m, [0.1, 0.5], [0.3, 0.1], [100, 100])).toBeNull(); // not a point of the paths
});
