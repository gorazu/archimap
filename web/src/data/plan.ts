// Shapes of the drawn plan: a node per walkable area of each map, and
// corridors between them. Area positions only matter for maps split into
// several parts (Forêt maléfique): elsewhere suns aren't mirrored between
// maps, so exact crossing points would just make corridors zig-zag, and
// unsplit maps keep a centre node and straight corridors.
import { edgePoint, segmentPolygon, TILE_HEIGHT, tileCenter, tilePoint, type Point } from "./geometry";
import { mapKey, zoneLinks, type Zone } from "./zones";

// Thin: the map layouts underneath show the real paths; corridors show the connections.
const HALF_WIDTH = TILE_HEIGHT * 0.045;

export interface PlanShapes {
  /** One per walkable area with exits (or the tile centre without area data). */
  nodes: Point[];
  /** Corridor pieces, as polygons. */
  bands: Point[][];
  /** Where corridors cross from one map to the next. */
  joints: Point[];
}

export function planShapes(zone: Zone): PlanShapes {
  const size = zone.tile_size;
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  const split = (x: number, y: number) => (maps.get(mapKey(x, y))?.areas?.length ?? 0) > 1;
  const areaPoint = (x: number, y: number, i: number): Point => {
    const uv = maps.get(mapKey(x, y))?.areas?.[i];
    return uv && split(x, y) ? tilePoint(x, y, uv, size) : tileCenter(x, y, size);
  };
  const nodes = zone.maps.flatMap((m) =>
    split(m.x, m.y) ? m.areas!.map((uv) => tilePoint(m.x, m.y, uv, size)) : [tileCenter(m.x, m.y, size)],
  );
  const bands: Point[][] = [];
  const joints: Point[] = [];
  const covered = new Set<string>();
  for (const { a, b, t } of zone.passages ?? []) {
    const pair = `${a[0]},${a[1]}|${b[0]},${b[1]}`;
    if (!split(a[0], a[1]) && !split(b[0], b[1])) continue; // drawn straight below
    const from = areaPoint(a[0], a[1], a[2]);
    const to = areaPoint(b[0], b[1], b[2]);
    const cross = edgePoint([a[0], a[1]], [b[0], b[1]], t, size);
    bands.push(segmentPolygon(from, cross, HALF_WIDTH), segmentPolygon(cross, to, HALF_WIDTH));
    joints.push(cross);
    covered.add(pair);
  }
  // Between unsplit maps, and passages known only at the map level (walked
  // in a recording, added by hand, no area data): a straight corridor.
  for (const [x1, y1, x2, y2] of zoneLinks(zone)) {
    if (covered.has(`${x1},${y1}|${x2},${y2}`)) continue;
    bands.push(segmentPolygon(areaPoint(x1, y1, 0), areaPoint(x2, y2, 0), HALF_WIDTH));
  }
  return { nodes, bands, joints };
}
