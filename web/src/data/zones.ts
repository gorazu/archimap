// Types and loaders for the pipeline output in public/data (see zone.json schema in Plan.md).

export interface ZoneSummary {
  zone: string;
  name: string;
  maps: number;
}

export type MapSource = "ocr" | "inferred" | "manual";

export interface MapEntry {
  x: number;
  y: number;
  tile: string;
  thumb: string;
  source: MapSource;
  confidence: number;
  video_time: number;
}

export interface Zone {
  zone: string;
  name: string;
  source_video: string;
  tile_size: [number, number];
  maps: MapEntry[];
  /** Passages between maps as [x1, y1, x2, y2], from the recorded route. Missing in older data. */
  links?: [number, number, number, number][];
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
