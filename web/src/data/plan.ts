// Paths drawn on the plan: walking routes inside each map (from the game's
// map files: between its suns, over its floor) and the map changes between
// them, from the sun you leave by to the sun you arrive at.
import { tileCenter, tilePoint, type Point } from "./geometry";
import { mapKey, zoneLinks, type Zone } from "./zones";

export interface PlanShapes {
  /** Walking routes inside maps. */
  routes: Point[][];
  /** Map changes, from one map's sun to the next map's. */
  crossings: Point[][];
  /** Centres of maps without route data, which get straight connections. */
  nodes: Point[];
}

export function planShapes(zone: Zone): PlanShapes {
  const size = zone.tile_size;
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  const centre = (x: number, y: number) => tileCenter(x, y, size);
  const areaPoint = (x: number, y: number, i: number): Point => {
    const uv = maps.get(mapKey(x, y))?.areas?.[i];
    return uv ? tilePoint(x, y, uv, size) : centre(x, y);
  };
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
