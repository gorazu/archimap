import { expect, test } from "bun:test";
import { matchSubarea, nameSimilarity, parseLocation, resolveZone, type ZoneLookup } from "./location";

const zones: ZoneLookup[] = [
  { zone: "egouts-de-bonta", subareas: ["Egout de Bonta"], maps: new Set(["-26,-57", "-26,-56"]) },
  { zone: "souterrain-astrub", subareas: ["Souterrain d'Astrub"], maps: new Set(["5,-20", "6,-20"]) },
  { zone: "souterrain-profond-astrub", subareas: ["Souterrain profond d'Astrub"], maps: new Set(["4,-20"]) },
];

test("location line from OCR lines", () => {
  expect(parseLocation(["Bonta (Egout de Bonta) - Bontarien", "Coordonnées : -26, -57"])).toBe("Egout de Bonta");
  expect(parseLocation(["Bonta (Eqgout de Bonta - Bontarien"])).toBe("Eqgout de Bonta"); // lost ")"
  expect(parseLocation(["Coordonnées : 5, -20"])).toBeNull();
  expect(parseLocation(["( )"])).toBeNull();
});

test("names match despite accents and OCR mistakes", () => {
  expect(nameSimilarity("Égout de Brâkmar", "Egout de Brakmar")).toBe(1);
  expect(matchSubarea("Eqgout de Bonta", zones)).toBe("egouts-de-bonta");
  expect(matchSubarea("Souterrain d'Astrub", zones)).toBe("souterrain-astrub");
  expect(matchSubarea("Souterrain profond d'Astrub", zones)).toBe("souterrain-profond-astrub");
  expect(matchSubarea("Cité d'Astrub", zones)).toBeNull();
});

test("the location line decides when readable", () => {
  // Walking in the city above the souterrain: same coordinates, not the zone.
  expect(resolveZone("5,-20", "Cité d'Astrub", "souterrain-astrub", zones)).toBeNull();
  // Crossing into the next zone.
  expect(resolveZone("4,-20", "Souterrain profond d'Astrub", "souterrain-astrub", zones)).toBe("souterrain-profond-astrub");
});

test("coordinates decide when the location can't be read", () => {
  expect(resolveZone("5,-20", null, "souterrain-astrub", zones)).toBe("souterrain-astrub");
  expect(resolveZone("4,-20", null, "souterrain-astrub", zones)).toBe("souterrain-profond-astrub");
  expect(resolveZone("99,99", null, "souterrain-astrub", zones)).toBeNull();
});

test("a zone made of several sub-areas matches each of them", () => {
  const grouped: ZoneLookup[] = [
    { zone: "souterrains-astrub", subareas: ["Souterrain d'Astrub", "Souterrain profond d'Astrub"], maps: new Set(["5,-20", "4,-20"]) },
  ];
  expect(matchSubarea("Souterrain profond d'Astrub", grouped)).toBe("souterrains-astrub");
  expect(matchSubarea("Souterrain d'Astrub", grouped)).toBe("souterrains-astrub");
  expect(matchSubarea("Cité d'Astrub", grouped)).toBeNull();
});
