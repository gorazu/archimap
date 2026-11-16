// A map's own layout (floor, walls, suns), from the game's map files,
// drawn inside its plan tile. Cells sit on the game's diamond grid.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const OFF = 0;
export const WALL = 1;
export const FLOOR = 2;
export const SUN = 3;

export interface MapLayout {
  w: number;
  h: number;
  /** Cells packed 3 per character, 2 bits each (see pipeline client_maps.map_layout). */
  cells: string;
}

export function cellCount(w: number, h: number): number {
  return w * h + (w - 1) * (h - 1);
}

export function decodeLayout({ w, h, cells }: MapLayout): Uint8Array {
  const values = new Uint8Array(cellCount(w, h));
  for (let i = 0; i < values.length; i++) {
    const packed = ALPHABET.indexOf(cells[Math.floor(i / 3)]);
    values[i] = (packed >> (2 * (i % 3))) & 3;
  }
  return values;
}

/** Position of a cell in half-cells: x 0..2w-2 across, y 0..2h-2 down. */
export function cellPosition(id: number, w: number): [number, number] {
  const pair = Math.floor(id / (2 * w - 1));
  const rest = id % (2 * w - 1);
  return rest < w ? [rest * 2, pair * 2] : [(rest - w) * 2 + 1, pair * 2 + 1];
}

/**
 * Walkable part of each cell (-1 for walls and off-map cells): some maps are
 * split into parts you can't walk between. Out of fights, characters move
 * in 8 directions.
 */
export function floorParts(values: Uint8Array, w: number): Int16Array {
  const byPos = new Map<string, number>();
  values.forEach((_, id) => byPos.set(cellPosition(id, w).join(","), id));
  const parts = new Int16Array(values.length).fill(-1);
  const steps = [[1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  let next = 0;
  for (let start = 0; start < values.length; start++) {
    if (parts[start] !== -1 || (values[start] !== FLOOR && values[start] !== SUN)) continue;
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (parts[id] !== -1 || (values[id] !== FLOOR && values[id] !== SUN)) continue;
      parts[id] = next;
      const [x, y] = cellPosition(id, w);
      for (const [dx, dy] of steps) {
        const other = byPos.get(`${x + dx},${y + dy}`);
        if (other !== undefined) stack.push(other);
      }
    }
    next++;
  }
  return parts;
}

// Half a cell in pixels: game cells are about twice as wide as tall.
const HALF_W = 12;
const HALF_H = 6;
const COLOURS = { wall: "#17130f", sun: "#ffc94d", deadFloor: "#3d3428" };
// Floor with exits; when a map has several such parts, each gets its own colour.
const FLOORS = ["#6e5d45", "#4f6c80", "#80594d", "#5a7a52"];

/** The layout as an image (data URL), for an image overlay in the plan tile. */
export function drawLayout(layout: MapLayout): string {
  const { w, h } = layout;
  const values = decodeLayout(layout);
  const parts = floorParts(values, w);
  // Only parts with an exit matter; scraps of floor without one stay muted.
  const withExit = [...new Set([...values].flatMap((v, id) => (v === SUN ? [parts[id]] : [])))];
  const colourOf = (part: number) => {
    const rank = withExit.indexOf(part);
    if (rank < 0) return COLOURS.deadFloor;
    return FLOORS[withExit.length > 1 ? rank % FLOORS.length : 0];
  };
  const canvas = document.createElement("canvas");
  canvas.width = (2 * w) * HALF_W;
  canvas.height = (2 * h) * HALF_H;
  const ctx = canvas.getContext("2d")!;
  const suns: [number, number][] = [];
  values.forEach((value, id) => {
    if (value === OFF) return;
    const [x, y] = cellPosition(id, w);
    const cx = (x + 1) * HALF_W;
    const cy = (y + 1) * HALF_H;
    ctx.beginPath();
    ctx.moveTo(cx, cy - HALF_H);
    ctx.lineTo(cx + HALF_W, cy);
    ctx.lineTo(cx, cy + HALF_H);
    ctx.lineTo(cx - HALF_W, cy);
    ctx.closePath();
    ctx.fillStyle = value === WALL ? COLOURS.wall : colourOf(parts[id]);
    ctx.fill();
    if (value === SUN) suns.push([cx, cy]);
  });
  ctx.fillStyle = COLOURS.sun;
  for (const [cx, cy] of suns) {
    ctx.beginPath();
    ctx.arc(cx, cy, HALF_H * 0.9, 0, 2 * Math.PI);
    ctx.fill();
  }
  return canvas.toDataURL();
}
