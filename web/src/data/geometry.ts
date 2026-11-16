// Placement of map tiles in Leaflet's CRS.Simple. Every tile is TILE_HEIGHT
// units tall; in-game y grows downward while latitude grows upward.

export const TILE_HEIGHT = 100;
const GAP = 1;

export type Bounds = [[number, number], [number, number]];

export function tileWidth([w, h]: [number, number]): number {
  return h > 0 ? (TILE_HEIGHT * w) / h : TILE_HEIGHT;
}

export function tileBounds(x: number, y: number, size: [number, number]): Bounds {
  const tw = tileWidth(size);
  return [
    [-(y + 1) * TILE_HEIGHT + GAP, x * tw + GAP],
    [-y * TILE_HEIGHT - GAP, (x + 1) * tw - GAP],
  ];
}

export function zoneBounds(maps: { x: number; y: number }[], size: [number, number]): Bounds {
  if (maps.length === 0) return [[-TILE_HEIGHT, 0], [0, tileWidth(size)]];
  const xs = maps.map((m) => m.x);
  const ys = maps.map((m) => m.y);
  const tw = tileWidth(size);
  return [
    [-(Math.max(...ys) + 1) * TILE_HEIGHT, Math.min(...xs) * tw],
    [-Math.min(...ys) * TILE_HEIGHT, (Math.max(...xs) + 1) * tw],
  ];
}

export function tileCenter(x: number, y: number, size: [number, number]): [number, number] {
  const tw = tileWidth(size);
  return [-(y + 0.5) * TILE_HEIGHT, (x + 0.5) * tw];
}

export type Point = [number, number];

/** A point of a tile given as (u, v), 0..1 from its top-left corner. */
export function tilePoint(x: number, y: number, [u, v]: [number, number], size: [number, number]): Point {
  return [-(y + v) * TILE_HEIGHT, (x + u) * tileWidth(size)];
}
