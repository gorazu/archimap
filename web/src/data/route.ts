// The shortest walk that visits every map of a zone at least once (each
// extra move is a map visited again). Maps can be split into parts you
// can't walk between, so the walk runs over map parts: a map counts as
// visited when any of its parts is. Exact solutions are out of reach (it's
// a travelling salesman problem); greedy nearest-map walks from every start,
// improved by reversing stretches of the visiting order (2-opt) and moving
// single maps in it (or-opt), get close.
import { mapKey, zoneLinks, type Zone } from "./zones";

export interface RouteNode {
  map: string; // "x,y"
  x: number;
  y: number;
  area: number;
}

export interface RouteStep {
  from: number; // node index
  to: number;
  /** Suns used to leave `from` and enter `to`, as (u, v) in their tiles, when known. */
  leave?: [number, number];
  enter?: [number, number];
}

export interface ZoneGraph {
  nodes: RouteNode[];
  edges: Map<number, Map<number, RouteStep>>;
  dist: Int16Array; // n × n, -1 when unreachable
  prev: Int16Array; // n × n: previous node on a shortest path from row to column
}

export interface Route {
  steps: RouteStep[];
  start: number;
  /** Maps visited, in order of first visit. */
  order: string[];
  /** Maps to visit that can't be reached from the start inside the zone. */
  unreachable: string[];
}

export function buildGraph(zone: Zone): ZoneGraph {
  const nodes: RouteNode[] = [];
  const index = new Map<string, number>();
  for (const m of zone.maps) {
    const parts = Math.max(1, m.areas?.length ?? 0);
    for (let area = 0; area < parts; area++) {
      index.set(`${mapKey(m.x, m.y)}#${area}`, nodes.length);
      nodes.push({ map: mapKey(m.x, m.y), x: m.x, y: m.y, area });
    }
  }
  const edges = new Map<number, Map<number, RouteStep>>(nodes.map((_, i) => [i, new Map()]));
  const connect = (a: number | undefined, b: number | undefined, leave?: [number, number], enter?: [number, number]) => {
    if (a === undefined || b === undefined || a === b) return;
    edges.get(a)!.set(b, { from: a, to: b, leave, enter });
    edges.get(b)!.set(a, { from: b, to: a, leave: enter, enter: leave });
  };
  const covered = new Set<string>();
  for (const p of zone.passages ?? []) {
    connect(
      index.get(`${p.a[0]},${p.a[1]}#${p.a[2]}`),
      index.get(`${p.b[0]},${p.b[1]}#${p.b[2]}`),
      p.ua,
      p.ub,
    );
    covered.add(`${p.a[0]},${p.a[1]}|${p.b[0]},${p.b[1]}`);
  }
  // Passages known only between maps (recording, manual fix): between first parts.
  for (const [x1, y1, x2, y2] of zoneLinks(zone)) {
    if (!covered.has(`${x1},${y1}|${x2},${y2}`)) connect(index.get(`${x1},${y1}#0`), index.get(`${x2},${y2}#0`));
  }
  const n = nodes.length;
  const dist = new Int16Array(n * n).fill(-1);
  const prev = new Int16Array(n * n).fill(-1);
  for (let s = 0; s < n; s++) {
    dist[s * n + s] = 0;
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head];
      for (const v of edges.get(u)!.keys()) {
        if (dist[s * n + v] !== -1) continue;
        dist[s * n + v] = dist[s * n + u] + 1;
        prev[s * n + v] = u;
        queue.push(v);
      }
    }
  }
  return { nodes, edges, dist, prev };
}

function pathBetween(g: ZoneGraph, a: number, b: number): number[] {
  const n = g.nodes.length;
  const path = [b];
  while (path[path.length - 1] !== a) path.push(g.prev[a * n + path[path.length - 1]]);
  return path.reverse();
}

/** Greedy walk: from `start`, go to the nearest map still to visit. Returns the
 * visiting order as nodes (one per map, where it was first reached). */
function greedyTour(g: ZoneGraph, start: number, targets: Set<string>): number[] {
  const n = g.nodes.length;
  const tour = [start];
  const seen = new Set([g.nodes[start].map]);
  let at = start;
  for (;;) {
    let best = -1;
    for (let v = 0; v < n; v++) {
      const d = g.dist[at * n + v];
      if (d <= 0 || seen.has(g.nodes[v].map) || !targets.has(g.nodes[v].map)) continue;
      if (best === -1 || d < g.dist[at * n + best]) best = v;
    }
    if (best === -1) return tour;
    for (const v of pathBetween(g, at, best).slice(1)) {
      if (!seen.has(g.nodes[v].map)) {
        seen.add(g.nodes[v].map);
        if (targets.has(g.nodes[v].map)) tour.push(v);
      }
    }
    at = best;
  }
}

function tourCost(g: ZoneGraph, tour: number[]): number {
  const n = g.nodes.length;
  let cost = 0;
  for (let i = 1; i < tour.length; i++) cost += g.dist[tour[i - 1] * n + tour[i]];
  return cost;
}

/**
 * Improve a visiting order (start kept) while it shortens the walk: reverse
 * a stretch of it (2-opt), or move one map elsewhere in it (or-opt). Moves
 * are evaluated by their change in cost only.
 */
function improve(g: ZoneGraph, tour: number[]): number[] {
  const n = g.nodes.length;
  const d = (a: number, b: number) => g.dist[a * n + b];
  const t = [...tour];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < t.length - 1; i++) {
      for (let j = i + 1; j < t.length; j++) {
        const before = d(t[i - 1], t[i]) + (j + 1 < t.length ? d(t[j], t[j + 1]) : 0);
        const after = d(t[i - 1], t[j]) + (j + 1 < t.length ? d(t[i], t[j + 1]) : 0);
        if (after < before) {
          t.splice(i, j - i + 1, ...t.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
    for (let i = 1; i < t.length; i++) {
      const x = t[i];
      const removed = -d(t[i - 1], x) + (i + 1 < t.length ? d(t[i - 1], t[i + 1]) - d(x, t[i + 1]) : 0);
      const rest = [...t.slice(0, i), ...t.slice(i + 1)];
      let best = 0;
      let at = -1;
      for (let j = 1; j <= rest.length; j++) {
        if (j === i) continue; // same place
        const added = d(rest[j - 1], x) + (j < rest.length ? d(x, rest[j]) - d(rest[j - 1], rest[j]) : 0);
        if (removed + added < best) {
          best = removed + added;
          at = j;
        }
      }
      if (at !== -1) {
        rest.splice(at, 0, x);
        t.splice(0, t.length, ...rest);
        improved = true;
      }
    }
  }
  return t;
}

function expand(g: ZoneGraph, tour: number[], targets: Set<string>): Route {
  const steps: RouteStep[] = [];
  for (let i = 1; i < tour.length; i++) {
    const path = pathBetween(g, tour[i - 1], tour[i]);
    for (let k = 1; k < path.length; k++) steps.push(g.edges.get(path[k - 1])!.get(path[k])!);
  }
  const order: string[] = [];
  for (const node of [tour[0], ...steps.map((s) => s.to)]) {
    if (!order.includes(g.nodes[node].map)) order.push(g.nodes[node].map);
  }
  const unreachable = [...targets].filter((m) => !order.includes(m)).sort();
  return { steps, start: tour[0], order, unreachable };
}

/**
 * Shortest walk found visiting every map in `targets`, starting from one of
 * `starts` (all nodes when not given: the best starting point is chosen).
 */
export function planRoute(g: ZoneGraph, targets: Set<string>, starts?: number[]): Route | null {
  const candidates = starts ?? g.nodes.map((_, i) => i).filter((i) => targets.has(g.nodes[i].map));
  if (candidates.length === 0) return null;
  // From every start: greedy walk, then improved; keep the one reaching the
  // most maps, then the shortest.
  let best: number[] | null = null;
  for (const s of candidates) {
    const tour = improve(g, greedyTour(g, s, targets));
    if (!best || tour.length > best.length || (tour.length === best.length && tourCost(g, tour) < tourCost(g, best))) {
      best = tour;
    }
  }
  return expand(g, best!, targets);
}

/** Where a sun is in the tile, in words, for the live guide ("en bas à gauche"). */
export function describePosition([u, v]: [number, number]): string {
  const vertical = v < 0.33 ? "en haut" : v > 0.67 ? "en bas" : "";
  const horizontal = u < 0.33 ? "à gauche" : u > 0.67 ? "à droite" : "";
  if (vertical && horizontal) return `${vertical} ${horizontal}`;
  if (vertical) return `${vertical} au centre`;
  if (horizontal) return horizontal.replace("à ", "au milieu à ");
  return "au centre";
}
