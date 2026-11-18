// The shortest walk that visits every map of a zone at least once (each
// extra move is a map visited again). Maps can be split into parts you
// can't walk between, so the walk runs over map parts: a map counts as
// visited when any of its parts is. Exact solutions are out of reach (it's
// a travelling salesman problem); greedy nearest-map walks from every start,
// improved by reversing stretches of the visiting order (2-opt) and moving
// single maps in it (or-opt), get close.
import { mapKey, zoneLinks, type Zone, type ZoneEntrance } from "./zones";

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
  const connect = (
    a: number | undefined, b: number | undefined, leave?: [number, number], enter?: [number, number], oneway?: "ab" | "ba",
  ) => {
    if (a === undefined || b === undefined || a === b) return;
    // Two suns can lead to the same part: keep the first one listed.
    if (oneway !== "ba" && !edges.get(a)!.has(b)) edges.get(a)!.set(b, { from: a, to: b, leave, enter });
    if (oneway !== "ab" && !edges.get(b)!.has(a)) edges.get(b)!.set(a, { from: b, to: a, leave: enter, enter: leave });
  };
  const covered = new Set<string>();
  for (const p of zone.passages ?? []) {
    connect(
      index.get(`${p.a[0]},${p.a[1]}#${p.a[2]}`),
      index.get(`${p.b[0]},${p.b[1]}#${p.b[2]}`),
      p.ua,
      p.ub,
      p.oneway,
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
    // Maps still reachable from here: a one-way passage mustn't cut any of them off.
    const left = new Set<string>();
    for (let v = 0; v < n; v++) {
      const map = g.nodes[v].map;
      if (g.dist[at * n + v] > 0 && !seen.has(map) && targets.has(map)) left.add(map);
    }
    const keepsAll = (v: number) => {
      const reach = new Set<string>();
      for (let w = 0; w < n; w++) if (g.dist[v * n + w] >= 0) reach.add(g.nodes[w].map);
      for (const map of left) if (!reach.has(map) && map !== g.nodes[v].map && !pathBetween(g, at, v).some((u) => g.nodes[u].map === map)) return false;
      return true;
    };
    let best = -1;
    let fallback = -1;
    for (let v = 0; v < n; v++) {
      const d = g.dist[at * n + v];
      if (d <= 0 || seen.has(g.nodes[v].map) || !targets.has(g.nodes[v].map)) continue;
      if (fallback === -1 || d < g.dist[at * n + fallback]) fallback = v;
      if ((best === -1 || d < g.dist[at * n + best]) && keepsAll(v)) best = v;
    }
    if (best === -1) best = fallback;
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

/** Moves from a to b; a large number when b can't be reached from a (one-way passages). */
const FAR = 1_000_000;
function cost(g: ZoneGraph, a: number, b: number): number {
  const d = g.dist[a * g.nodes.length + b];
  return d < 0 ? FAR : d;
}

function tourCost(g: ZoneGraph, tour: number[]): number {
  let total = 0;
  for (let i = 1; i < tour.length; i++) total += cost(g, tour[i - 1], tour[i]);
  return total;
}

/**
 * Improve a visiting order (start kept) while it shortens the walk: reverse
 * a stretch of it (2-opt), move one map elsewhere in it (or-opt), or visit
 * a map by another of its parts. One-way passages make the cost of a stretch
 * depend on its direction, so a reversed stretch is priced both ways.
 */
function improve(g: ZoneGraph, tour: number[]): number[] {
  const d = (a: number, b: number) => cost(g, a, b);
  const partsOf = new Map<string, number[]>();
  g.nodes.forEach((node, i) => partsOf.set(node.map, [...(partsOf.get(node.map) ?? []), i]));
  const t = [...tour];
  let improved = true;
  while (improved) {
    improved = false;
    // Running costs of the order forwards and backwards, for 2-opt.
    let forward: number[] = [];
    let backward: number[] = [];
    const sums = () => {
      forward = [0];
      backward = [0];
      for (let k = 1; k < t.length; k++) {
        forward.push(forward[k - 1] + d(t[k - 1], t[k]));
        backward.push(backward[k - 1] + d(t[k], t[k - 1]));
      }
    };
    sums();
    for (let i = 1; i < t.length - 1; i++) {
      for (let j = i + 1; j < t.length; j++) {
        const next = j + 1 < t.length;
        const before = d(t[i - 1], t[i]) + (forward[j] - forward[i]) + (next ? d(t[j], t[j + 1]) : 0);
        const after = d(t[i - 1], t[j]) + (backward[j] - backward[i]) + (next ? d(t[i], t[j + 1]) : 0);
        if (after < before) {
          t.splice(i, j - i + 1, ...t.slice(i, j + 1).reverse());
          sums();
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
    // Split maps: the part reached first can matter.
    for (let i = 1; i < t.length; i++) {
      const next = i + 1 < t.length;
      const here = d(t[i - 1], t[i]) + (next ? d(t[i], t[i + 1]) : 0);
      for (const other of partsOf.get(g.nodes[t[i]].map)!) {
        if (other !== t[i] && d(t[i - 1], other) + (next ? d(other, t[i + 1]) : 0) < here) {
          t[i] = other;
          improved = true;
          break;
        }
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

/** Small seeded random generator (mulberry32): same zone, same route. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Best visiting order found from a fixed start: greedy walk, improved, then
 * many tries of moving a short stretch of it elsewhere and improving again,
 * keeping the shortest (iterated local search). Worth it for a route that is
 * computed once: about 10% shorter than improving the greedy walk alone.
 */
function searchFrom(g: ZoneGraph, start: number, targets: Set<string>, tries: number, seed: number): number[] {
  const random = seeded(seed);
  let best = improve(g, greedyTour(g, start, targets));
  let bestCost = tourCost(g, best);
  for (let k = 0; k < tries && best.length > 3; k++) {
    const t = [...best];
    const length = 1 + Math.floor(random() * Math.min(6, t.length - 2));
    const from = 1 + Math.floor(random() * (t.length - length));
    const stretch = t.splice(from, length);
    t.splice(1 + Math.floor(random() * (t.length - 1 + 1)), 0, ...stretch);
    const candidate = improve(g, t);
    const cost = tourCost(g, candidate);
    if (cost < bestCost) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

export interface EntranceRoute {
  /** null: the zone has no known entrance, the route starts where it's shortest. */
  entrance: ZoneEntrance | null;
  route: Route;
}

/**
 * A route over the whole zone from each entrance, best first (most maps
 * reached, then fewest moves). Computed once per zone; progress along it
 * then comes from the maps checked (routeProgress), not from replanning.
 */
export function planEntrances(zone: Zone, g: ZoneGraph, tries = 200): EntranceRoute[] {
  const targets = new Set(zone.maps.map((m) => mapKey(m.x, m.y)));
  const results: EntranceRoute[] = [];
  for (const [k, entrance] of (zone.entrances ?? []).entries()) {
    const map = mapKey(entrance.x, entrance.y);
    const node = g.nodes.findIndex((n) => n.map === map && n.area === entrance.area);
    const start = node !== -1 ? node : g.nodes.findIndex((n) => n.map === map);
    if (start === -1) continue;
    results.push({ entrance, route: expand(g, searchFrom(g, start, targets, tries, 1 + k), targets) });
  }
  if (results.length === 0) {
    const route = planRoute(g, targets);
    if (route) results.push({ entrance: null, route });
  }
  return results.sort((a, b) => b.route.order.length - a.route.order.length || a.route.steps.length - b.route.steps.length);
}

export interface Progress {
  /** Map nodes along the route: the start, then where each step leads. */
  sequence: number[];
  /** The first map of the route's order not checked yet (null: all done). */
  nextGoal: string | null;
  /** Positions in `sequence` of the previous goal and of the next one. */
  fromIndex: number;
  goalIndex: number;
}

export function routeProgress(route: Route, checked: ReadonlySet<string>, g: ZoneGraph): Progress {
  const sequence = [route.start, ...route.steps.map((s) => s.to)];
  const firstVisit = new Map<string, number>();
  sequence.forEach((node, i) => {
    if (!firstVisit.has(g.nodes[node].map)) firstVisit.set(g.nodes[node].map, i);
  });
  const k = route.order.findIndex((m) => !checked.has(m));
  if (k === -1) return { sequence, nextGoal: null, fromIndex: sequence.length - 1, goalIndex: sequence.length - 1 };
  return {
    sequence,
    nextGoal: route.order[k],
    fromIndex: k === 0 ? 0 : firstVisit.get(route.order[k - 1])!,
    goalIndex: firstVisit.get(route.order[k])!,
  };
}

export interface Guidance {
  /** The move to make now (null: nothing left, or no way from here). */
  step: RouteStep | null;
  /** Off the route: the step leads back to it. */
  detour: boolean;
  /** Moves left until the end of the route. */
  remaining: number;
}

/**
 * The next move from where the player is (`here`: the nodes of their map,
 * the part they entered by first). On the stretch leading to the next goal,
 * it is the route's own next step; elsewhere, the shortest way back to that
 * goal. The route itself never changes.
 */
export function guideFrom(route: Route, progress: Progress, g: ZoneGraph, here: number[]): Guidance {
  const n = g.nodes.length;
  if (!progress.nextGoal) return { step: null, detour: false, remaining: 0 };
  const { sequence, fromIndex, goalIndex } = progress;
  for (let i = goalIndex - 1; i >= fromIndex; i--) {
    if (here.includes(sequence[i])) {
      return { step: route.steps[i], detour: false, remaining: route.steps.length - i };
    }
  }
  const goal = sequence[goalIndex];
  const reachable = here.filter((h) => g.dist[h * n + goal] > 0);
  if (reachable.length === 0) return { step: null, detour: true, remaining: route.steps.length - goalIndex };
  const from = reachable.reduce((a, b) => (g.dist[b * n + goal] < g.dist[a * n + goal] ? b : a));
  const path = pathBetween(g, from, goal);
  return {
    step: g.edges.get(path[0])!.get(path[1])!,
    detour: true,
    remaining: g.dist[from * n + goal] + route.steps.length - goalIndex,
  };
}

/**
 * The parts of `map` the live player may be on. On a split map: the part
 * the suggested sun leads to, if that's the move they made; else the parts
 * reachable from where they were on the previous map; else all of them.
 * Guiding from a part they aren't on could send them where they can't go.
 */
export function locate(
  g: ZoneGraph, map: string, previousMap: string | null, previousParts: number[], arrivedBy: RouteStep | null,
): number[] {
  const here = g.nodes.flatMap((n, i) => (n.map === map ? [i] : []));
  if (here.length === 1) return here;
  if (arrivedBy && g.nodes[arrivedBy.from]?.map === previousMap && g.nodes[arrivedBy.to]?.map === map) return [arrivedBy.to];
  const before = previousParts.filter((i) => g.nodes[i]?.map === previousMap);
  const from = before.length ? before : g.nodes.flatMap((n, i) => (n.map === previousMap ? [i] : []));
  const reached = here.filter((i) => from.some((j) => g.edges.get(j)!.has(i)));
  return reached.length ? reached : here;
}

export type TilePosition =
  | "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";

/** Where a sun is in the tile, for the live guide to say ("bottom-left"). */
export function describePosition([u, v]: [number, number]): TilePosition {
  const vertical = v < 0.33 ? "top" : v > 0.67 ? "bottom" : "";
  const horizontal = u < 0.33 ? "left" : u > 0.67 ? "right" : "";
  if (vertical && horizontal) return `${vertical}-${horizontal}`;
  return vertical || horizontal || "center";
}
