import type { MapLayout } from "./layout";

// Types and loaders for the pipeline output in public/data (see zone.json schema in Plan.md).

export interface ZoneSummary {
  zone: string;
  name: string;
  maps: number;
  /** In-game sub-area name, as in the game's location line ("Bonta (Egout de Bonta)"). */
  subarea?: string;
  /** Sub-areas of a zone made of several, which can also be shown alone. */
  parts?: ZonePart[];
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
  /** Passages between maps as [x1, y1, x2, y2], from the recorded route. Missing in older data. */
  links?: [number, number, number, number][];
  /**
   * Ways into the zone: ladders and suns leading out of it (from the map
   * files), or added by hand in the zone's config (an NPC).
   */
  entrances?: ZoneEntrance[];
  parts?: ZonePart[];
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
  }[];
}

/**
 * Passages to draw on the plan. Older zone files have no links: then every
 * pair of neighbouring maps is assumed to connect.
 */
export function zoneLinks(zone: Zone): [number, number, number, number][] {
  if (zone.links) return zone.links;
  const keys = new Set(zone.maps.map((m) => mapKey(m.x, m.y)));
  return zone.maps.flatMap((m) =>
    [[m.x + 1, m.y], [m.x, m.y + 1]]
      .filter(([x, y]) => keys.has(mapKey(x, y)))
      .map(([x, y]) => [m.x, m.y, x, y] as [number, number, number, number]),
  );
}

export interface ZoneEntrance {
  x: number;
  y: number;
  /** Part of the map it's in. */
  area: number;
  kind: "ladder" | "sun" | "manual";
  /** Its ladder or sun, as (u, v) in the tile. */
  uv?: [number, number];
  /** Where it leads (sub-area names), or the label of a manual entrance. */
  to: string;
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
  return zone;
}
