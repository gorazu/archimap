import { expect, test } from "bun:test";
import { isSelection, partOf, zonePart, type Zone, type ZoneSummary } from "./zones";

const parts = [
  { part: "haut", name: "Haut", subarea: "Souterrain du haut", maps: 2 },
  { part: "bas", name: "Bas", subarea: "Souterrain du bas", maps: 1 },
];
const zone: Zone = {
  zone: "souterrains",
  name: "Souterrains",
  source_video: null,
  tile_size: [100, 60],
  maps: [
    { x: 0, y: 0, source: "client", subarea: "Souterrain du haut" },
    { x: 1, y: 0, source: "client", subarea: "Souterrain du haut" },
    { x: 1, y: 1, source: "client", subarea: "Souterrain du bas" },
  ],
  links: [[0, 0, 1, 0], [1, 0, 1, 1]],
  passages: [
    { a: [0, 0, 0], b: [1, 0, 0], t: 0.5, ua: [0.96, 0.5], ub: [0.04, 0.5] },
    { a: [1, 0, 0], b: [1, 1, 0], t: 0.5, ua: [0.5, 0.97], ub: [0.5, 0.03] },
  ],
  entrances: [{ x: 0, y: 0, area: 0, kind: "manual", to: "Surface" }],
  parts,
};

test("a part shown alone keeps its maps, and is entered from the other parts too", () => {
  const bas = zonePart(zone, parts[1]);
  expect(bas.name).toBe("Bas");
  expect(bas.maps.map((m) => [m.x, m.y])).toEqual([[1, 1]]);
  expect(bas.links).toEqual([]);
  expect(bas.passages).toEqual([]);
  expect(bas.entrances).toEqual([{ x: 1, y: 1, area: 0, kind: "sun", uv: [0.5, 0.03], to: "Souterrain du haut" }]);
  expect(zonePart(zone, parts[0]).entrances?.map((e) => e.to)).toEqual(["Surface", "Souterrain du bas"]);
});

test("selections name a zone or one of its parts", () => {
  const zones: ZoneSummary[] = [{ zone: "souterrains", name: "Souterrains", maps: 3, parts }];
  expect(isSelection(zones, "souterrains")).toBe(true);
  expect(isSelection(zones, "souterrains/bas")).toBe(true);
  expect(isSelection(zones, "souterrains/nulle-part")).toBe(false);
  expect(partOf(zone, "1,1")?.part).toBe("bas");
});
