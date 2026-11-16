import { expect, test } from "bun:test";
import { buildGraph, describePosition, guideFrom, planEntrances, planRoute, routeProgress } from "./route";
import type { Zone } from "./zones";

const zone = (cells: [number, number][], links: [number, number, number, number][], extra: Partial<Zone> = {}): Zone => ({
  zone: "z", name: "z", source_video: null, tile_size: [100, 100],
  maps: cells.map(([x, y]) => ({ x, y, source: "client" as const })),
  links,
  ...extra,
});
const all = (z: Zone) => new Set(z.maps.map((m) => `${m.x},${m.y}`));

test("a corridor is walked end to end, from an end", () => {
  const z = zone([[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0, 1, 0], [1, 0, 2, 0], [2, 0, 3, 0]]);
  const route = planRoute(buildGraph(z), all(z))!;
  expect(route.steps).toHaveLength(3); // no map visited twice
  expect([route.order[0], route.order[3]].sort()).toEqual(["0,0", "3,0"]);
});

test("a star is walked with as few returns as possible", () => {
  // Centre (1,1) with four arms of length 1: start at an arm's end, then
  // centre, arm, centre, arm, centre, arm = 6 moves (centre visited 3 times).
  const z = zone([[1, 1], [0, 1], [2, 1], [1, 0], [1, 2]], [[0, 1, 1, 1], [1, 1, 2, 1], [1, 0, 1, 1], [1, 1, 1, 2]]);
  const route = planRoute(buildGraph(z), all(z))!;
  expect(route.steps).toHaveLength(6);
  expect(new Set(route.order)).toEqual(all(z));
});

test("only maps still to visit count, from a given start", () => {
  const z = zone([[0, 0], [1, 0], [2, 0]], [[0, 0, 1, 0], [1, 0, 2, 0]]);
  const g = buildGraph(z);
  const start = g.nodes.findIndex((n) => n.map === "1,0");
  const route = planRoute(g, new Set(["2,0"]), [start])!;
  expect(route.steps.map((s) => g.nodes[s.to].map)).toEqual(["2,0"]);
});

test("the parts of a split map are reached separately", () => {
  // (1,0) has two parts: part 0 joins (0,0), part 1 joins (2,0). They only
  // meet through (1,1) below, which joins both.
  const z: Zone = {
    ...zone([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]], []),
    maps: [
      { x: 0, y: 0, source: "client" }, { x: 1, y: 0, source: "client", areas: [[0.2, 0.5], [0.8, 0.5]] },
      { x: 2, y: 0, source: "client" }, { x: 0, y: 1, source: "client" }, { x: 1, y: 1, source: "client" },
      { x: 2, y: 1, source: "client" },
    ],
    passages: [
      { a: [0, 0, 0], b: [1, 0, 0], t: 0.5, ua: [0.9, 0.5], ub: [0.1, 0.5] },
      { a: [1, 0, 1], b: [2, 0, 0], t: 0.5 },
      { a: [0, 0, 0], b: [0, 1, 0], t: 0.5 },
      { a: [0, 1, 0], b: [1, 1, 0], t: 0.5 },
      { a: [1, 1, 0], b: [2, 1, 0], t: 0.5 },
      { a: [2, 0, 0], b: [2, 1, 0], t: 0.5 },
    ],
  };
  const g = buildGraph(z);
  const left = g.nodes.findIndex((n) => n.map === "1,0" && n.area === 0);
  const right = g.nodes.findIndex((n) => n.map === "1,0" && n.area === 1);
  expect(g.dist[left * g.nodes.length + right]).toBe(6); // around through the bottom row
  const route = planRoute(g, all(z))!;
  expect(new Set(route.order)).toEqual(all(z));
  const first = route.steps.find((s) => g.nodes[s.from].map === "0,0" && g.nodes[s.to].map === "1,0");
  if (first) expect([first.leave, first.enter]).toEqual([[0.9, 0.5], [0.1, 0.5]]); // suns kept, in walking direction
});

test("maps out of reach inside the zone are reported, not planned", () => {
  const z = zone([[0, 0], [1, 0], [5, 5]], [[0, 0, 1, 0]]);
  const route = planRoute(buildGraph(z), all(z))!;
  expect(route.order.sort()).toEqual(["0,0", "1,0"]);
  expect(route.unreachable).toEqual(["5,5"]);
});

test("sun positions in words", () => {
  expect(describePosition([0.1, 0.9])).toBe("en bas à gauche");
  expect(describePosition([0.5, 0.05])).toBe("en haut au centre");
  expect(describePosition([0.95, 0.5])).toBe("au milieu à droite");
  expect(describePosition([0.5, 0.5])).toBe("au centre");
});

const line = (n: number): Zone =>
  zone(Array.from({ length: n }, (_, i) => [i, 0] as [number, number]),
       Array.from({ length: n - 1 }, (_, i) => [i, 0, i + 1, 0] as [number, number, number, number]));

test("routes start at the zone's entrances, best first", () => {
  const z = { ...line(5), entrances: [
    { x: 2, y: 0, area: 0, kind: "ladder" as const, to: "Surface" },
    { x: 0, y: 0, area: 0, kind: "sun" as const, to: "Elsewhere" },
  ] };
  const plans = planEntrances(z, buildGraph(z));
  expect(plans.map((p) => [p.entrance!.x, p.route.steps.length])).toEqual([[0, 4], [2, 6]]);
});

test("without entrances, the route starts where it's shortest", () => {
  const plans = planEntrances(line(3), buildGraph(line(3)));
  expect(plans).toHaveLength(1);
  expect(plans[0].entrance).toBeNull();
  expect(plans[0].route.steps).toHaveLength(2);
});

test("progress follows the checked maps, the route stays the same", () => {
  const z = line(4);
  const g = buildGraph(z);
  const route = planRoute(g, all(z), [g.nodes.findIndex((n) => n.map === "0,0")])!;
  expect(routeProgress(route, new Set(), g).nextGoal).toBe("0,0");
  const p = routeProgress(route, new Set(["0,0", "1,0"]), g);
  expect([p.nextGoal, p.fromIndex, p.goalIndex]).toEqual(["2,0", 1, 2]);
  expect(routeProgress(route, all(z), g).nextGoal).toBeNull();
});

test("the guide follows the route, or leads back to it", () => {
  const z = line(4);
  const g = buildGraph(z);
  const node = (m: string) => g.nodes.findIndex((n) => n.map === m);
  const route = planRoute(g, all(z), [node("0,0")])!;
  const progress = routeProgress(route, new Set(["0,0", "1,0"]), g);
  const onRoute = guideFrom(route, progress, g, [node("1,0")]);
  expect([g.nodes[onRoute.step!.to].map, onRoute.detour, onRoute.remaining]).toEqual(["2,0", false, 2]);
  const off = guideFrom(route, progress, g, [node("0,0")]); // went back: lead to the next goal
  expect([g.nodes[off.step!.to].map, off.detour, off.remaining]).toEqual(["1,0", true, 3]);
  expect(guideFrom(route, routeProgress(route, all(z), g), g, [node("3,0")]).step).toBeNull();
});
