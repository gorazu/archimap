// Which map the player is on, from live readings. Maps stacked on one cell
// (the landings of the Arbre Hakam) share coordinates: they're told apart by
// the way the player came, map change by map change.
import type { ZoneGraph } from "./route";
import { gameCoords, mapKey, type Zone } from "./zones";

export interface Arrival {
  /** In-game coordinates read. */
  position: [number, number];
  /** Map changes seen since the last arrival (loading screens; 0 when none are seen). */
  moves: number;
}

/** Maps (by key) one map change away from each map, from the route graph. */
export function nextMaps(graph: ZoneGraph): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  graph.edges.forEach((to, from) => {
    const a = graph.nodes[from].map;
    for (const i of to.keys()) {
      const b = graph.nodes[i].map;
      if (a === b) continue;
      if (!next.has(a)) next.set(a, new Set());
      next.get(a)!.add(b);
    }
  });
  return next;
}

/**
 * The maps the player can be on after an arrival, given the ones they could
 * be on before: those `moves` map changes away, at the coordinates read.
 * When that leaves none (a loading screen missed, or one too many), within
 * one more change; else any map at the coordinates. At the start, a map
 * with an entrance is preferred.
 */
export function followMaps(zone: Zone, next: Map<string, Set<string>>, before: string[], arrival: Arrival): string[] {
  const position = mapKey(...arrival.position);
  const here = zone.maps.filter((m) => mapKey(...gameCoords(m)) === position).map((m) => mapKey(m.x, m.y));
  if (here.length <= 1) return here;
  if (!before.length) {
    const entrances = new Set((zone.entrances ?? []).map((e) => mapKey(e.x, e.y)));
    const ways = here.filter((k) => entrances.has(k));
    return ways.length ? ways : here;
  }
  const after = (from: Set<string>) => new Set([...from].flatMap((k) => [...(next.get(k) ?? [])]));
  // Unseen loading screens: the coordinates changed, so at least one map change.
  const moves = Math.max(arrival.moves, before.every((k) => !here.includes(k)) ? 1 : 0);
  let reached = new Set(before);
  for (let i = 0; i < moves; i++) reached = after(reached);
  let found = here.filter((k) => reached.has(k));
  if (!found.length) {
    const near = new Set(before);
    for (let i = 0; i <= moves; i++) for (const k of after(near)) near.add(k);
    found = here.filter((k) => near.has(k));
  }
  return found.length ? found : here;
}

/** One arrival as followed: the maps the player could be on, and the map changes that led there. */
export interface Followed {
  maybe: string[];
  moves: number;
}

/**
 * Once the last arrival leaves a single map, the earlier ones still in
 * doubt are settled by the way back: of each one's maps, the one that leads
 * to the next map (within its map changes, give or take one). Returns the
 * maps settled this way, latest first.
 */
export function settleBack(next: Map<string, Set<string>>, history: Followed[]): string[] {
  const settled: string[] = [];
  let after = history[history.length - 1];
  if (after?.maybe.length !== 1) return settled;
  for (let i = history.length - 2; i >= 0; i--) {
    const target = after.maybe[0];
    const leads = (k: string) => {
      if (after.moves === 0 && k === target) return true;
      let reached = new Set([k]);
      for (let step = 0; step <= after.moves; step++) {
        reached = new Set([...reached, ...[...reached].flatMap((r) => [...(next.get(r) ?? [])])]);
        if (reached.has(target)) return true;
      }
      return false;
    };
    if (history[i].maybe.length <= 1) break; // already known
    const maybe = history[i].maybe.filter(leads);
    if (maybe.length !== 1) break;
    settled.push(maybe[0]);
    after = { maybe, moves: history[i].moves };
  }
  return settled;
}
