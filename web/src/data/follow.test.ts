import { expect, test } from "bun:test";
import { followMaps, nextMaps, settleBack } from "./follow";
import { buildGraph } from "./route";
import { landingsZone, mapKey, type Zone } from "./zones";

// Three landings stacked on (0, 0): stairs on the cell join 10 to 20 and 20 to 30.
const tree = landingsZone({
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
  entrances: [{ x: 0, y: 0, area: 0, kind: "sun", to: "Jungle", floor: 0 }],
  floors: [{ maps: 2 }, { maps: 1 }, { maps: 1 }],
  stairs: [{ a: [10, 0], b: [20, 0] }, { a: [20, 0], b: [30, 0] }],
} as Zone);
const next = nextMaps(buildGraph(tree));
const key = (id: number) => {
  const m = tree.maps.find((m) => m.id === id)!;
  return mapKey(m.x, m.y);
};

test("stacked maps are told apart by the way the player came", () => {
  // At the start: the map with the entrance.
  let maybe = followMaps(tree, next, [], { position: [0, 0], moves: 0 });
  expect(maybe).toEqual([key(10)]);
  // A map change on the same cell: up the stairs.
  maybe = followMaps(tree, next, maybe, { position: [0, 0], moves: 1 });
  expect(maybe).toEqual([key(20)]);
  // Another: up or back down, can't tell yet...
  maybe = followMaps(tree, next, maybe, { position: [0, 0], moves: 1 });
  expect(maybe.sort()).toEqual([key(10), key(30)].sort());
  // ...until the next map: only reached from the bottom landing.
  maybe = followMaps(tree, next, maybe, { position: [1, 0], moves: 1 });
  expect(maybe).toEqual([key(11)]);
});

test("the coordinates changing count as a map change, loading screen seen or not", () => {
  // Two map changes seen as one: still found, within one more change.
  const maybe = followMaps(tree, next, [key(11)], { position: [0, 0], moves: 1 });
  expect(maybe).toEqual([key(10)]);
  expect(followMaps(tree, next, [key(11)], { position: [0, 0], moves: 0 })).toEqual([key(10)]);
});

test("maps walked through while in doubt are settled once the next one is known", () => {
  const trail = [
    { maybe: [key(20)], moves: 1 },
    { maybe: [key(10), key(30)], moves: 1 },
    { maybe: [key(11)], moves: 1 },
  ];
  expect(settleBack(next, trail)).toEqual([key(10)]);
  expect(settleBack(next, trail.slice(0, 2))).toEqual([]);
});
