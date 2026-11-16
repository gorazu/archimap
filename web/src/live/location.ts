// Which zone the player is in: from the game's location line, e.g.
// "Bonta (Egout de Bonta) - Bontarien", whose part in parentheses is the
// sub-area, with the coordinates as a fallback when it can't be read.
// Coordinates alone can be ambiguous: underground zones share them with
// the surface above.

export interface ZoneLookup {
  zone: string;
  /** In-game sub-area name, from zones.json. */
  subarea?: string;
  /** Map keys "x,y". */
  maps: ReadonlySet<string>;
}

/** Lower case, no accents, letters and digits only: "Égout d'X" -> "egoutdx". */
export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 for identical names, lower as OCR mistakes add up. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** Sub-area from the OCR'd lines of the top-left corner, or null. */
export function parseLocation(lines: string[]): string | null {
  for (const line of lines) {
    const open = line.indexOf("(");
    if (open < 0) continue;
    const rest = line.slice(open + 1);
    // OCR sometimes loses the closing parenthesis: stop at " - " (alignment) then.
    const end = rest.includes(")") ? rest.indexOf(")") : rest.includes(" - ") ? rest.indexOf(" - ") : rest.length;
    const name = rest.slice(0, end).trim();
    if (normalizeName(name).length >= 4) return name;
  }
  return null;
}

/** Zone whose sub-area best matches the location read, or null. */
export function matchSubarea(location: string, zones: ZoneLookup[], minSimilarity = 0.75): string | null {
  let best: { zone: string; score: number } | null = null;
  for (const z of zones) {
    if (!z.subarea) continue;
    const score = nameSimilarity(location, z.subarea);
    if (!best || score > best.score) best = { zone: z.zone, score };
  }
  return best && best.score >= minSimilarity ? best.zone : null;
}

/**
 * Zone the position belongs to, or null when outside every zone. A readable
 * location line decides; otherwise the current zone if it has the map, else
 * the only zone that has it.
 */
export function resolveZone(
  key: string,
  location: string | null,
  current: string | null,
  zones: ZoneLookup[],
): string | null {
  if (location !== null) return matchSubarea(location, zones);
  const here = zones.find((z) => z.zone === current);
  if (here?.maps.has(key)) return here.zone;
  const candidates = zones.filter((z) => z.maps.has(key));
  return candidates.length === 1 ? candidates[0].zone : null;
}
