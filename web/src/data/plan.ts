// Paths drawn on the plan: walking routes inside each map (from the game's
// map files: between its suns, over its floor) and the map changes between
// them, from the sun you leave by to the sun you arrive at.
import { tileCenter, tilePoint, type Point } from "./geometry";
import type { Route, ZoneGraph } from "./route";
import { mapKey, zoneLinks, type Zone } from "./zones";

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
  /** The walk, from sun to sun. */
  line: Point[];
  /** Visiting order: a number where each map is first reached. */
  numbers: { label: string; position: Point }[];
  /** The sun to click next, when known. */
  nextSun: Point | null;
}

export function routeShapes(zone: Zone, graph: ZoneGraph, route: Route): RouteShapes {
  const size = zone.tile_size;
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  const nodePoint = (i: number) => {
    const n = graph.nodes[i];
    return partPoint(zone, maps, n.x, n.y, n.area);
  };
  const start = nodePoint(route.start);
  const line = [start];
  const numbers = [{ label: "1", position: start }];
  const seen = new Set([graph.nodes[route.start].map]);
  for (const step of route.steps) {
    const from = graph.nodes[step.from];
    const to = graph.nodes[step.to];
    line.push(step.leave ? tilePoint(from.x, from.y, step.leave, size) : nodePoint(step.from));
    const arrival = step.enter ? tilePoint(to.x, to.y, step.enter, size) : nodePoint(step.to);
    line.push(arrival);
    if (!seen.has(to.map)) {
      seen.add(to.map);
      numbers.push({ label: String(seen.size), position: arrival });
    }
  }
  const first = route.steps[0];
  const nextSun = first?.leave ? tilePoint(graph.nodes[first.from].x, graph.nodes[first.from].y, first.leave, size) : null;
  return { line, numbers, nextSun };
}
