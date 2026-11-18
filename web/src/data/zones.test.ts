import { expect, test } from "bun:test";
import {
  countedMaps, floorStairs, floorView, isSelection, landingsZone, partOf, progressKey, withPassageEnds, zonePart, type Zone,
  type ZoneSummary,
} from "./zones";

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

const tree: Zone = {
  zone: "arbre",
  name: "Arbre",
  source_video: null,
  tile_size: [100, 60],
  maps: [
    { x: 0, y: 0, id: 10, floor: 0, source: "client" },
    { x: 1, y: 0, id: 11, floor: 0, source: "client" },
    { x: 0, y: 0, id: 20, floor: 1, source: "client" },
    { x: 0, y: 0, id: 30, floor: 2, source: "client" },
  ],
  links: [[0, 0, 1, 0, 0]],
  passages: [{ a: [0, 0, 0], b: [1, 0, 0], t: 0.5, floor: 0 }],
  entrances: [{ x: 1, y: 0, area: 0, kind: "sun", to: "Jungle", floor: 0 }],
  floors: [{ maps: 2 }, { maps: 1 }, { name: "Village", check: false, maps: 1 }],
  stairs: [{ a: [11, 0], b: [20, 0], ua: [0.5, 0.2] }, { a: [20, 0], b: [30, 0] }],
};

test("landings are laid out side by side, joined by their stairs", () => {
  const flat = landingsZone(tree);
  expect(flat.maps.map((m) => [m.id, m.x, m.y, m.at])).toEqual([
    [10, 0, 0, [0, 0]], [11, 1, 0, [1, 0]], [20, 3, 0, [0, 0]], [30, 5, 0, [0, 0]],
  ]);
  expect(flat.links).toEqual([[0, 0, 1, 0]]);
  expect(flat.passages?.[0].b).toEqual([1, 0, 0]);
  // Stairs are passages from their suns.
  expect(flat.passages?.slice(1).map((p) => [p.a, p.b, p.ua])).toEqual([[[1, 0, 0], [3, 0, 0], [0.5, 0.2]], [[3, 0, 0], [5, 0, 0], undefined]]);
  expect(flat.entrances?.[0]).toMatchObject({ x: 1, y: 0, at: [1, 0] });
});

test("stacked maps are saved under their id; landings with nothing to check aren't counted", () => {
  const flat = landingsZone(tree);
  expect(progressKey(tree, tree.maps[2])).toBe("0,0@20");
  expect(progressKey(flat, flat.maps[2])).toBe("0,0@20");
  expect(progressKey(zone, zone.maps[0])).toBe("0,0");
  expect(countedMaps(tree).map((m) => m.id)).toEqual([10, 11, 20]);
});

test("a landing is shown alone, with stairs to the landings they reach", () => {
  const flat = landingsZone(tree);
  const ground = floorView(flat, 0);
  expect(ground.maps.map((m) => m.id)).toEqual([10, 11]);
  expect(ground.passages).toHaveLength(1);
  expect(floorStairs(flat, 0)).toEqual([{ x: 1, y: 0, uv: [0.5, 0.2], to: 1 }]);
  expect(floorStairs(flat, 1).map((s) => s.to)).toEqual([0, 2]);
});

test("a passage without a sun on its other map ends on the floor nearest to it", () => {
  // 2x2 map below: one floor cell, at the top left (x 0, y 0 in half-cells); the rest is wall.
  const layout = { w: 2, h: 2, cells: "GF" };
  const single: Zone = {
    ...zone,
    maps: [{ x: 0, y: 0, source: "client" }, { x: 0, y: 1, source: "client", layout }],
    passages: [{ a: [0, 0, 0], b: [0, 1, 0], t: 0.5, ua: [0.3, 0.95] }],
  };
  expect(withPassageEnds(single).passages![0].ub).toEqual([0.25, 0.25]);
});
