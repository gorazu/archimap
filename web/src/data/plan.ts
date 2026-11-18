import { floorPath } from "./layout";
// Paths drawn on the plan: walking routes inside each map (from the game's
// map files: between its suns, over its floor) and the map changes between
// them, from the sun you leave by to the sun you arrive at.
import { tileCenter, tilePoint, type Point } from "./geometry";
import type { Route, RouteStep, ZoneGraph } from "./route";
import { mapKey, zoneLinks, type MapEntry, type Zone } from "./zones";

export interface PlanShapes {
  /** Walking routes inside maps. */
  routes: Point[][];
  /** Map changes, from one map's sun to the next map's. */
  crossings: Point[][];
  /** Centres of maps without route data, which get straight connections. */
  nodes: Point[];
}

/** Where a map part sits in its tile (its centre when the map has no part data). */
function partPoint(zone: Zone, maps: Map<string, Zone["maps"][number]>, x: number, y: number, part: number): Point {
  const uv = maps.get(mapKey(x, y))?.areas?.[part];
  return uv ? tilePoint(x, y, uv, zone.tile_size) : tileCenter(x, y, zone.tile_size);
}

export function planShapes(zone: Zone): PlanShapes {
  const size = zone.tile_size;
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  const centre = (x: number, y: number) => tileCenter(x, y, size);
  const areaPoint = (x: number, y: number, i: number) => partPoint(zone, maps, x, y, i);
  const routes = zone.maps.flatMap((m) => (m.paths ?? []).map((route) => route.map((uv) => tilePoint(m.x, m.y, uv, size))));
  const nodes = zone.maps.filter((m) => !m.paths?.length).map((m) => centre(m.x, m.y));
  const crossings: Point[][] = [];
  const covered = new Set<string>();
  for (const { a, b, ua, ub } of zone.passages ?? []) {
    crossings.push([
      ua ? tilePoint(a[0], a[1], ua, size) : areaPoint(a[0], a[1], a[2]),
      ub ? tilePoint(b[0], b[1], ub, size) : areaPoint(b[0], b[1], b[2]),
    ]);
    covered.add(`${a[0]},${a[1]}|${b[0]},${b[1]}`);
  }
  // Passages known only at the map level (walked in a recording, added by
  // hand, or zones without map files): a straight line between the maps.
  for (const [x1, y1, x2, y2] of zoneLinks(zone)) {
    if (!covered.has(`${x1},${y1}|${x2},${y2}`)) crossings.push([centre(x1, y1), centre(x2, y2)]);
  }
  return { routes, crossings, nodes };
}

export interface RouteShapes {
  /** The walk: over each map's floor from the sun you arrive by to the one you leave by. */
  line: Point[];
  /** Index in `line` where you arrive on each map of the walk (0: the start). */
  arrivals: number[];
  /** Visiting order: a number where each map is first reached. */
  numbers: { map: string; label: string; position: Point }[];
}

/** `start`: where the walk starts in its first map, (u, v), when known (an entrance's sun). */
export function routeShapes(zone: Zone, graph: ZoneGraph, route: Route, start?: [number, number]): RouteShapes {
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  const nodePoint = (i: number) => {
    const n = graph.nodes[i];
    return partPoint(zone, maps, n.x, n.y, n.area);
  };
  // Across the map: along its drawn paths, else over its floor, else straight.
  const across = (node: number, from: [number, number] | undefined, to: [number, number] | undefined): Point[] => {
    const n = graph.nodes[node];
    const m = maps.get(n.map);
    if (!m || !from || !to) return [];
    const path = alongPaths(m, from, to, zone.tile_size) ?? (m.layout ? floorPath(m.layout, from, to) : null);
    return (path ?? []).slice(1, -1).map((uv) => tilePoint(n.x, n.y, uv, zone.tile_size));
  };
  const first = graph.nodes[route.start];
  const startPoint = start ? tilePoint(first.x, first.y, start, zone.tile_size) : nodePoint(route.start);
  const line = [startPoint];
  const arrivals = [0];
  // The start is numbered when it's a map to visit (not a village walked through, say).
  const numbers = [{ map: first.map, label: route.order[0] === first.map ? "1" : "", position: startPoint }];
  const seen = new Set([first.map]);
  let entered = start;
  for (const step of route.steps) {
    line.push(...across(step.from, entered, step.leave), leavePoint(zone, graph, step));
    const to = graph.nodes[step.to];
    const arrival = step.enter ? tilePoint(to.x, to.y, step.enter, zone.tile_size) : nodePoint(step.to);
    arrivals.push(line.length);
    line.push(arrival);
    entered = step.enter;
    // Numbered where first reached; maps only walked through (nothing to check) aren't.
    if (!seen.has(to.map) && route.order.includes(to.map)) {
      seen.add(to.map);
      numbers.push({ map: to.map, label: String(route.order.indexOf(to.map) + 1), position: arrival });
    }
  }
  return { line, arrivals, numbers };
}

/** Where a step leaves its map: its sun, or the map part when unknown. */
export function leavePoint(zone: Zone, graph: ZoneGraph, step: RouteStep): Point {
  const from = graph.nodes[step.from];
  if (step.leave) return tilePoint(from.x, from.y, step.leave, zone.tile_size);
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  return partPoint(zone, maps, from.x, from.y, from.area);
}

type UV = [number, number];

/** The map's drawn paths as a graph of their points (where one path meets another, it's split there). */
const pathGraphs = new WeakMap<MapEntry, { points: UV[]; next: Map<number, number[]> }>();
function pathGraph(m: MapEntry) {
  let graph = pathGraphs.get(m);
  if (graph) return graph;
  const points: UV[] = [];
  const index = new Map<string, number>();
  const id = (p: UV) => {
    const key = `${p[0]},${p[1]}`;
    if (!index.has(key)) {
      index.set(key, points.length);
      points.push(p);
    }
    return index.get(key)!;
  };
  // Each path starts at a sun and ends on an earlier path, often mid-stretch:
  // split that stretch at the meeting point.
  const routes = (m.paths ?? []).map((route) => [...route]);
  const ends = routes.flatMap((route) => [route[0], route[route.length - 1]]);
  for (const route of routes) {
    for (let k = 0; k < route.length - 1; k++) {
      const [a, b] = [route[k], route[k + 1]];
      const inside = ends.filter((p) => between(a, b, p)).sort((p, q) => dist2(a, p) - dist2(a, q));
      if (inside.length) {
        route.splice(k + 1, 0, ...inside);
        k += inside.length;
      }
    }
  }
  const next = new Map<number, number[]>();
  const join = (a: number, b: number) => {
    if (a === b) return;
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  };
  for (const route of routes) for (let k = 0; k < route.length - 1; k++) join(id(route[k]), id(route[k + 1]));
  graph = { points, next };
  pathGraphs.set(m, graph);
  return graph;
}

const dist2 = (a: UV, b: UV) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Whether p lies strictly inside the segment a-b (points are rounded to 0.001). */
function between(a: UV, b: UV, p: UV): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length === 0 || Math.abs(cross) / length > 0.002) return false;
  const along = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length ** 2;
  return along > 0.001 && along < 0.999;
}

/**
 * The shortest way between two points along the map's drawn paths, so the
 * walk follows them: from each point to the path nearest to it (a sun the
 * paths don't reach, say, next to one they do), then along the paths. Null
 * when the paths don't join them.
 */
export function alongPaths(m: MapEntry, from: UV, to: UV, [w, h]: [number, number]): UV[] | null {
  const { points, next } = pathGraph(m);
  const nearest = (p: UV) => {
    let best = -1;
    points.forEach((q, i) => {
      if (dist2(p, q) < 0.04 && (best === -1 || dist2(p, q) < dist2(p, points[best]))) best = i;
    });
    return best;
  };
  const start = nearest(from);
  const goal = nearest(to);
  if (start === -1 || goal === -1) return null;
  // Lengths as on screen: tiles are wider than tall.
  const aspect = h > 0 ? w / h : 1;
  const length = (a: number, b: number) =>
    Math.hypot((points[a][0] - points[b][0]) * aspect, points[a][1] - points[b][1]);
  const best = new Map<number, number>([[start, 0]]);
  const previous = new Map<number, number>();
  const open = new Set([start]);
  while (open.size) {
    let at = -1;
    for (const i of open) if (at === -1 || best.get(i)! < best.get(at)!) at = i;
    open.delete(at);
    if (at === goal) break;
    for (const other of next.get(at) ?? []) {
      const d = best.get(at)! + length(at, other);
      if (d < (best.get(other) ?? Infinity)) {
        best.set(other, d);
        previous.set(other, at);
        open.add(other);
      }
    }
  }
  if (!best.has(goal)) return null;
  const path = [goal];
  while (path[path.length - 1] !== start) path.push(previous.get(path[path.length - 1])!);
  const along = path.reverse().map((i) => points[i]);
  // From and to themselves stay the ends, even when off the paths.
  return [from, ...along.filter((p, i) => !(i === 0 && dist2(p, from) < 1e-6) && !(i === along.length - 1 && dist2(p, to) < 1e-6)), to];
}
