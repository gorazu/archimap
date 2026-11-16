import type { MapLayout } from "./layout";

// Types and loaders for the pipeline output in public/data (see zone.json schema in Plan.md).

export interface ZoneSummary {
  zone: string;
  name: string;
  maps: number;
  /** In-game sub-area name, as in the game's location line ("Bonta (Egout de Bonta)"). */
  subarea?: string;
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
   * Paths between map areas, from the game's map files: area a of map
   * [x, y] to area b of its right or bottom neighbour, crossing their
   * shared edge at t (0..1 along it). Some maps have several separate paths.
   */
  passages?: { a: [number, number, number]; b: [number, number, number]; t: number }[];
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
