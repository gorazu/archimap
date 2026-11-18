import { nearestFloor, nearestSun, type MapLayout } from "./layout";

// Types and loaders for the pipeline output in public/data (see zone.json schema in Plan.md).

export interface ZoneSummary {
  zone: string;
  name: string;
  maps: number;
  /** In-game sub-area name, as in the game's location line ("Bonta (Egout de Bonta)"). */
  subarea?: string;
  /** Sub-areas of a zone made of several, which can also be shown alone. */
  parts?: ZonePart[];
  /** In-game sub-area names of a zone of several that can't be shown apart (stacked floors). */
  subareas?: string[];
}

export interface ZonePart {
  /** Its slug, after the zone's: "#zone/part". */
  part: string;
  name: string;
  /** In-game sub-area name. */
  subarea: string;
  maps: number;
}

/** "client": from the game client's map data rather than a recording. */
export type MapSource = "ocr" | "inferred" | "manual" | "client";

export interface MapEntry {
  x: number;
  y: number;
  source: MapSource;
  /** Walkable parts of the map that have exits, as (u, v) positions in the tile. */
  areas?: [number, number][];
  /** The map's own cells (floor, walls, suns), drawn in its plan tile. */
  layout?: MapLayout;
  /** Walking routes between the map's suns, over its floor: polylines of (u, v). */
  paths?: [number, number][][];
  /** In-game sub-area, in zones made of several. */
  subarea?: string;
  /** The game's map id, in zones of landings: maps there share coordinates. */
  id?: number;
  /** Index into Zone.floors. */
  floor?: number;
  /** In-game coordinates, when the map is drawn elsewhere (a landing laid out beside the others). */
  at?: [number, number];
  confidence?: number;
  video_time?: number;
}

export interface Zone {
  zone: string;
  name: string;
  source_video: string | null;
  /** Game-area size of the recording: gives the plan tiles their shape. */
  tile_size: [number, number];
  maps: MapEntry[];
  /** Passages between maps as [x1, y1, x2, y2], from the recorded route. Missing in older data. With floors, the floor comes fifth. */
  links?: [number, number, number, number, number?][];
  /**
   * Ways into the zone: ladders and suns leading out of it (from the map
   * files), or added by hand in the zone's config (an NPC).
   */
  entrances?: ZoneEntrance[];
  parts?: ZonePart[];
  /**
   * Landings, in climbing order, in zones whose maps are stacked over the
   * same coordinates (Arbre Hakam): each holds one map per cell, and maps,
   * passages, links and entrances say which one they're on. Shown side by
   * side (see landingsZone).
   */
  floors?: ZoneFloor[];
  /**
   * Stairs between landings (from a walk through the zone): their two maps
   * as [id, area], and the suns they leave each by when known.
   */
  stairs?: { a: [number, number]; b: [number, number]; ua?: [number, number]; ub?: [number, number] }[];
  subareas?: string[];
  /**
   * Paths between map areas, from the game's map files: area a of map
   * [x, y] to area b of its right or bottom neighbour (or another map, for
   * passages added by hand), crossing their shared edge at t (0..1 along
   * it), leaving a by the sun at ua and entering b by the sun at ub, (u, v)
   * in their tiles. Some maps have several paths.
   */
  passages?: {
    a: [number, number, number];
    b: [number, number, number];
    t: number;
    ua?: [number, number];
    ub?: [number, number];
    /** Walkable one way only, a to b ("ab") or b to a ("ba"): into a split map, a sun leads to one part. */
    oneway?: "ab" | "ba";
    floor?: number;
  }[];
}

export interface ZoneFloor {
  /** Only some landings have a name: the others are numbered. */
  name?: string;
  /** false: nothing to check there (a village), only walked through. */
  check?: boolean;
  maps: number;
}

/**
 * Passages to draw on the plan. Older zone files have no links: then every
 * pair of neighbouring maps is assumed to connect.
 */
export function zoneLinks(zone: Zone): [number, number, number, number][] {
  if (zone.links) return zone.links as [number, number, number, number][];
  const keys = new Set(zone.maps.map((m) => mapKey(m.x, m.y)));
  return zone.maps.flatMap((m) =>
    [[m.x + 1, m.y], [m.x, m.y + 1]]
      .filter(([x, y]) => keys.has(mapKey(x, y)))
      .map(([x, y]) => [m.x, m.y, x, y] as [number, number, number, number]),
  );
}

/** Maps each map's passages lead to, both ways, as keys: where the player can walk next. */
export function walkableNeighbours(zones: Zone[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a)!.add(b);
  };
  for (const zone of zones) {
    const pairs = [
      ...zoneLinks(zone).map(([x1, y1, x2, y2]) => [mapKey(x1, y1), mapKey(x2, y2)]),
      ...(zone.passages ?? []).map(({ a, b }) => [mapKey(a[0], a[1]), mapKey(b[0], b[1])]),
    ];
    for (const [a, b] of pairs) {
      link(a, b);
      link(b, a);
    }
  }
  return out;
}

export interface ZoneEntrance {
  x: number;
  y: number;
  /** Part of the map it's in. */
  area: number;
  kind: "ladder" | "sun" | "manual" | "zaap";
  /** Its ladder or sun, as (u, v) in the tile. */
  uv?: [number, number];
  /** Where it leads (sub-area names), or the label of a manual entrance. */
  to: string;
  floor?: number;
  /** In-game coordinates, when laid out elsewhere. */
  at?: [number, number];
}

/** What the select picks: a zone, or one part of it ("zone/part"). */
export function splitSelection(selection: string): { zone: string; part: string | null } {
  const [zone, part] = selection.split("/");
  return { zone, part: part ?? null };
}

export function isSelection(zones: ZoneSummary[], selection: string): boolean {
  const { zone, part } = splitSelection(selection);
  const found = zones.find((z) => z.zone === zone);
  return !!found && (part === null || !!found.parts?.some((p) => p.part === part));
}

/** The part a map is in, in a zone made of several (null otherwise). */
export function partOf(zone: Zone, key: string): ZonePart | null {
  const map = zone.maps.find((m) => mapKey(m.x, m.y) === key);
  return zone.parts?.find((p) => p.subarea === map?.subarea) ?? null;
}

/**
 * One part of a zone, shown alone: its maps and the passages between them.
 * Its entrances are the zone's ones inside it, plus the suns by which the
 * other parts lead into it.
 */
export function zonePart(zone: Zone, part: ZonePart): Zone {
  const maps = zone.maps.filter((m) => m.subarea === part.subarea);
  const keys = new Set(maps.map((m) => mapKey(m.x, m.y)));
  const inside = (x: number, y: number) => keys.has(mapKey(x, y));
  const subareaOf = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m.subarea]));
  const passages = zone.passages ?? [];
  const into: ZoneEntrance[] = [];
  for (const { a, b, ua, ub } of passages) {
    for (const [here, uv, there] of [[b, ub, a], [a, ua, b]] as const) {
      if (inside(here[0], here[1]) && !inside(there[0], there[1])) {
        into.push({ x: here[0], y: here[1], area: here[2], kind: "sun", ...(uv ? { uv } : {}),
                    to: subareaOf.get(mapKey(there[0], there[1])) ?? "" });
      }
    }
  }
  return {
    ...zone,
    name: part.name,
    maps,
    parts: undefined,
    links: zone.links?.filter(([x1, y1, x2, y2]) => inside(x1, y1) && inside(x2, y2)),
    passages: passages.filter(({ a, b }) => inside(a[0], a[1]) && inside(b[0], b[1])),
    entrances: [...(zone.entrances ?? []).filter((e) => inside(e.x, e.y)), ...into],
  };
}

/** A map's in-game coordinates, wherever it is drawn. */
export function gameCoords(m: MapEntry): [number, number] {
  return m.at ?? [m.x, m.y];
}

/** Key of a map in the saved progress: its coordinates, plus its id where maps are stacked. */
export function progressKey(zone: Zone, m: MapEntry): string {
  const [x, y] = gameCoords(m);
  return zone.floors && m.id !== undefined ? `${mapKey(x, y)}@${m.id}` : mapKey(x, y);
}

/** The maps to check: all of them, except on landings with nothing to check. */
export function countedMaps(zone: Zone): MapEntry[] {
  return zone.maps.filter((m) => m.floor === undefined || zone.floors?.[m.floor]?.check !== false);
}

/**
 * One landing of a laid out zone of landings (landingsZone), shown alone:
 * its maps keep their place and keys, so routes over the whole zone can be
 * drawn on it.
 */
export function floorView(zone: Zone, floor: number): Zone {
  const keys = new Set(zone.maps.filter((m) => m.floor === floor).map((m) => mapKey(m.x, m.y)));
  const on = (x: number, y: number) => keys.has(mapKey(x, y));
  return {
    ...zone,
    maps: zone.maps.filter((m) => m.floor === floor),
    links: zone.links?.filter(([x1, y1, x2, y2]) => on(x1, y1) && on(x2, y2)),
    passages: zone.passages?.filter(({ a, b }) => on(a[0], a[1]) && on(b[0], b[1])),
    entrances: zone.entrances?.filter((e) => e.floor === floor),
  };
}

/** A stair from a map of a landing: where it starts, and the landing it leads to. */
export interface FloorStair {
  x: number;
  y: number;
  /** Its sun in the map's tile, (u, v). */
  uv: [number, number];
  to: number;
}

/** Stairs leaving a landing of a laid out zone of landings. */
export function floorStairs(zone: Zone, floor: number): FloorStair[] {
  const maps = new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m]));
  const out: FloorStair[] = [];
  for (const p of zone.passages ?? []) {
    for (const [here, uv, there] of [[p.a, p.ua, p.b], [p.b, p.ub, p.a]] as const) {
      const [m, other] = [maps.get(mapKey(here[0], here[1])), maps.get(mapKey(there[0], there[1]))];
      if (m?.floor !== floor || other?.floor === undefined || other.floor === floor) continue;
      const at = uv ?? m.areas?.[here[2]] ?? [0.5, 0.5];
      // On the sun as drawn, which it replaces.
      out.push({ x: m.x, y: m.y, uv: (m.layout && nearestSun(m.layout, at)) || at, to: other.floor });
    }
  }
  return out;
}

/** Laid out landings stay this many maps wide at most, a row of them after another. */
const LANDINGS_WIDTH = 12;

/**
 * A zone of landings as one flat zone, for routes and following the player
 * over all of it: each landing keeps its shape, moved beside the previous
 * one (rows of them), so every map gets its own cell and can be keyed by it
 * again. Stairs become passages between the maps they join.
 */
export function landingsZone(zone: Zone): Zone {
  const floors = zone.floors ?? [];
  const offsets: [number, number][] = [];
  let cx = 0;
  let rowTop = 0;
  let rowHeight = 0;
  floors.forEach((_, n) => {
    const maps = zone.maps.filter((m) => m.floor === n);
    const xs = maps.map((m) => m.x);
    const ys = maps.map((m) => m.y);
    const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
    const [w, h] = [Math.max(...xs) - minX + 1, Math.max(...ys) - minY + 1];
    if (cx > 0 && cx + w > LANDINGS_WIDTH) {
      cx = 0;
      rowTop += rowHeight + 1;
      rowHeight = 0;
    }
    offsets.push([cx - minX, rowTop - minY]);
    cx += w + 1;
    rowHeight = Math.max(rowHeight, h);
  });
  const shift = (x: number, y: number, floor?: number): [number, number] =>
    floor === undefined ? [x, y] : [x + offsets[floor][0], y + offsets[floor][1]];
  const maps = zone.maps.map((m) => ({ ...m, x: shift(m.x, m.y, m.floor)[0], y: shift(m.x, m.y, m.floor)[1], at: [m.x, m.y] as [number, number] }));
  const byId = new Map(maps.map((m) => [m.id, m]));
  // Stairs: passages between the suns they use, as drawn (their icons replace them).
  const drawn = (m: MapEntry, uv?: [number, number]) => (uv && m.layout && nearestSun(m.layout, uv)) || uv;
  const stairs = (zone.stairs ?? []).flatMap(({ a, b, ua, ub }) => {
    const [ma, mb] = [byId.get(a[0]), byId.get(b[0])];
    if (!ma || !mb) return [];
    const [sa, sb] = [drawn(ma, ua), drawn(mb, ub)];
    return [{ a: [ma.x, ma.y, a[1]] as [number, number, number], b: [mb.x, mb.y, b[1]] as [number, number, number],
              t: 0.5, ...(sa ? { ua: sa } : {}), ...(sb ? { ub: sb } : {}) }];
  });
  return {
    ...zone,
    maps,
    links: (zone.links ?? []).map(([x1, y1, x2, y2, f]) => [...shift(x1, y1, f), ...shift(x2, y2, f)] as [number, number, number, number]),
    passages: [
      ...(zone.passages ?? []).map((p) => ({
        ...p,
        a: [...shift(p.a[0], p.a[1], p.floor), p.a[2]] as [number, number, number],
        b: [...shift(p.b[0], p.b[1], p.floor), p.b[2]] as [number, number, number],
      })),
      ...stairs,
    ],
    entrances: zone.entrances?.map((e) => ({ ...e, x: shift(e.x, e.y, e.floor)[0], y: shift(e.x, e.y, e.floor)[1], at: [e.x, e.y] })),
  };
}

export function dataUrl(path: string): string {
  return `${import.meta.env.BASE_URL}data/${path}`;
}

export function mapKey(x: number, y: number): string {
  return `${x},${y}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(dataUrl(path));
  // The dev server answers missing files with index.html, so check the type too.
  if (res.status === 404 || !res.headers.get("content-type")?.includes("json")) {
    return null;
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchZoneIndex(): Promise<ZoneSummary[]> {
  const index = await fetchJson<{ zones: ZoneSummary[] }>("zones.json");
  return index?.zones ?? [];
}

export async function fetchZone(slug: string): Promise<Zone> {
  const zone = await fetchJson<Zone>(`${encodeURIComponent(slug)}/zone.json`);
  if (!zone) throw new Error(`Zone « ${slug} » introuvable`);
  return withPassageEnds(zone);
}

/**
 * Passages with a sun on one side only (none faces back on the other map):
 * on that map, they start or end on the floor nearest to the sun, across
 * the edge, rather than in the map's middle over its walls.
 */
export function withPassageEnds(zone: Zone): Zone {
  if (!zone.passages?.some((p) => !p.ua !== !p.ub)) return zone;
  const mapAt = (x: number, y: number, floor?: number) =>
    zone.maps.find((m) => m.x === x && m.y === y && m.floor === floor);
  const across = (from: [number, number, number], uv: [number, number], to: [number, number, number], floor?: number) => {
    const m = mapAt(to[0], to[1], floor);
    const mirrored: [number, number] = [uv[0] - (to[0] - from[0]), uv[1] - (to[1] - from[1])];
    return (m?.layout && nearestFloor(m.layout, mirrored)) || undefined;
  };
  return {
    ...zone,
    passages: zone.passages.map((p) => {
      if (p.ua && !p.ub) {
        const ub = across(p.a, p.ua, p.b, p.floor);
        return ub ? { ...p, ub } : p;
      }
      if (p.ub && !p.ua) {
        const ua = across(p.b, p.ub, p.a, p.floor);
        return ua ? { ...p, ua } : p;
      }
      return p;
    }),
  };
}
