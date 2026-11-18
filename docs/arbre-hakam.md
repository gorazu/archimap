# Arbre Hakam: plan

Status (branch `feat/arbre-hakam`): built from a recording of a walk through the tree (`arbre-hakam.mkv`, 6.5 min). Steps 1–3 below were replaced by what the recording showed.

## What the recording showed

- **Reading it:** the video was cut into 108 map visits (`archimap.extract` with `--dip-ratio 0`, or the dark ground-floor maps are taken for loading screens). Each visit's sub-area and coordinates were read from the location line. Its map id was then found by matching the suns on screen against each candidate map's suns, from its map file. Close calls (monster tooltips over suns, fights) were checked by eye.
- **Coverage:** 64 maps were walked: 58 of the 63 tree maps, plus 6 in the village. Every map change goes either to a neighbouring cell or to another map on the same cell, which supports the matching.
- **Stairs:** a stair always leads to another map on the **same cell**. So stairs can never join maps on one floor grid, and the tree is a spiral of 18 landings, many of 1–3 maps. Five tree maps were never entered: the 1-map rooms at `[-55,15]` (11242, 11243, 11244, 11554) and 11545 at `[-52,15]`.
- **Suns:** inside a landing, the suns agree with the walk. 46 of the 47 walked moves were already passages from the map files.
- **Village:** the Village de la Canopée sits at the top, and part of the climb goes through it. Its whole outside is drawn, with nothing to check: 59 maps, one per cell. These are the village's lower map ids; the houses (11269 and up) are left out. Where two low ids share a cell, the one whose suns face its neighbours' is kept. Its zaap (map 11170, `[-54,15]`) is a second starting point.
- **End of the walk:** the last visit, read as the village at first, is 11157 in Village des Zoths, outside the zone.
- **Suns from the recording:** for each move of the walk, the sun used was read from the video: just after arriving, the player walks away from the arrival sun, and just before leaving, onto the exit sun. So the sun around which the picture changes most is the one used.
  - A reading only counts when that sun clearly beats the others, and when it fits the map: facing the other map for a move to a neighbouring cell, or inside the map.
  - A sun read for two different maps keeps only the reading facing its map, or none.
  - 76 readings are kept, in `"walked_suns"` as `[map, other map, sun]`. They decide stairs' suns and passages inside a landing over the guesses from the map files.
  - On landing 10, for example, 11125 is entered from 11124 by its staircase at the top, and left for 11126 by its bottom sun. 11126 has no sun facing back, so that passage ends in the middle of the map.
  - Extra stair suns now have to be on the same side of the map as the stair's sun: two suns on opposite sides can't be one stair.
- **Rooms left out:** five tree maps are left out of the zone (`"remove_map_ids"` in `zones/arbre-hakam.json`): 11242, 11243, 11244 and 11554 at `[-55,15]`, and 11545 at `[-52,15]`.
  - They are 1-map inside rooms, entered by a door or ladder within a map, with no sun to a neighbouring map.
  - The game's world map names 11243 the Atelier des alchimistes. Others are likely rooms such as the one that opens the Antre du Kralamoure dungeon.
  - The walk never entered them, and the map files can't tell which map leads in, so they can't be linked to the rest of the tree.
  - To bring them back, take them out of `"remove_map_ids"`. They then come back as landings of their own, and are linked once a recording shows which map each is entered from (add those moves to `"walked"`).
- **What was built:**
  - The landings, in climbing order, and the walked moves are in `zones/arbre-hakam.json`.
  - The web map shows one landing at a time with a lift-like picker. Drawing every landing side by side was tried, but the links between landings crossed the whole view.
  - Each stair replaces the sun it uses: one of its map's suns that no passage on the landing uses (33 of the 36 stair ends found one). Three maps have no such sun left (11114, 11152, 11164); their stair takes the sun nearest to where it ends on the other map. That only places the icon, the route is the same.
  - When a map's stairs all lead to one map, its suns left over lead there too (two ways up the same stair): each gets a stair icon. The paths inside the map join only the nearest of them, and routes take that one (11112 on landing 7, for example).
  - A stair end with no free sun, on a map where several suns are passages to the same sun of one neighbour: all but one of those suns are the stair (11114 on landing 8, 11164 in the village). Of two, the passage keeps the sun best in line with its neighbour's; of more, the one apart from the others, since the stair's suns look alike.
  - The route is one walk over the whole tree, taking the stairs. Only its part on the landing shown is drawn.
  - Live mode tells stacked maps apart from the last map the player was surely on. It doesn't see stairs yet, since they keep the same coordinates.

## What the client data says

Two sub-areas on Otomaï, 63 maps on 10 coordinates (a 3×3 block plus `[-55,15]`):

| Sub-area | Id | Maps | Coordinates |
|---|---|---|---|
| Tronc de l'arbre Hakam | 464 | 34 | 10 |
| Feuillage de L'arbre Hakam | 472 | 29 | 8 |

- **Map files:** every map exists only encrypted, and all 63 decrypt (map_keys).
- **Stacked maps:** up to 7 maps share one cell (`[-52,17]`), so this is a tower of floors, not one flat map. The location line does tell Tronc from Feuillage, but each of the two is still stacked.
- **No floor field:** the cached map list (`ANKXTRASO_*_MA.sol`) only has `x`, `y`, sub-area and fight cells. The map files add `backgroundNum`, `bOutdoor`, `ambianceId` and `musicId`. Nothing names a floor or says where a sun leads; that is server-side.
- **Floors from map ids:** maps were made one floor at a time, so runs of consecutive ids form floors with at most one map per cell. For example:
  - 10816–10824: the outdoor foliage ring, 8 maps, background 445;
  - 11080–11090: a trunk floor, 9 maps, background 567.

  Splitting at a repeated cell or an id gap > 3 gives 19 runs. About 8 of them are real floors; the rest are 1–3-map rooms (ladders, the tree's foot at `[-55,15]`).
- **Suns don't settle the links.** Here is how the 132 edge suns pair up with a sun facing them on a neighbouring cell:

  | Result | Suns |
  |---|---|
  | One candidate | 26 |
  | Several candidates | 73 |
  | No candidate | 33 |

  Suns line up across floors, because the floors are drawn on the same tree shape. Joining only suns that mirror exactly puts 42 maps from different floors into one group, which is impossible. The current `main_maps` / `SharedCoords` approach (keep one map per cell) can't express this zone.

So the files give the maps, their layouts and good floor candidates. **The links between maps need one walk-through in game**, and live mode needs a way to tell stacked maps apart, beyond the coordinates.

## 1. Data model: maps by id

- **`MapEntry`:** add `id` (client map id) and `floor` (index into a new `Zone.floors`).
- **`Zone.floors`:** a list of `{id, name, maps}`.
- **Passages and links:** add optional `ia` / `ib` map ids beside the `[x, y, area]` they already have.
- **One key helper:** `mapKey(m)` returns `"x,y"` when a map is alone on its cell (all current zones, so saved progress keeps working) and `"x,y@id"` when it shares the cell.

  Everything keyed by coordinates must move to this helper: progress, `walkableNeighbours`, route, plan, ZoneMap, FloatingGuide, live tracker. This is the biggest refactor, and it is worth doing first, alone, with the current zones unchanged.

## 2. Pipeline

- **Zone config `stacked: true`:** skips `main_maps` (choosing one map per cell). Every map is exported with its id.
- **Floors:** taken from id runs by default. The config can override:

  ```json
  "floors": [{"name": "Racines", "maps": [11242, 11243, 11244, 11554]}, …]
  ```

  This also gives names and merges small rooms into their floor.
- **Candidate passages:** suns pair only within a floor, or through a ladder / inner exit between floors. Pairs that are still ambiguous are exported as `candidate`, not drawn as sure links.
- **`add_passages` by map id:** in the config, `[[11080, "top", 11085], …]`. This is where the walk-through's result goes; it replaces the candidates.
- **Tests:**
  - id-run floors on a small synthetic zone;
  - `stacked` export keeps all maps;
  - `add_passages` overrides candidates.

## 3. Walk-through ("survey") in live mode

A maintainer mode, used once per stacked zone:

- Live capture runs as usual. On each map change, when the destination isn't certain, the floor picker asks "which one is this?" and shows the candidate maps' layouts (we already draw plan tiles from the cells, so they are recognisable).
- It records every transition, with the map id it came from, the edge or ladder used, and the map id it arrived at, plus a visual signature of each map (see 4b).
- **Export:** a JSON with the passages and signatures, to paste into `zones/arbre-hakam.json`. The pipeline then rebuilds the zone with sure links.

## 4. Live: telling stacked maps apart

Live mode keeps a current map **id**, not just coordinates, through three signals in order:

**a. Transitions.** Knowing the previous map and the side the player left by, the graph gives the possible destinations; usually there is one.
- A loading screen with **unchanged coordinates** means a ladder or vine to another floor.
- This needs map-change detection in the browser: a dark or near-uniform frame, then a big frame difference, like `frames.py` does on videos.

**b. Visual signature.** A small colour signature of the game area: a coarse colour histogram plus a tiny thumbnail hash, with the UI, chat and character area masked out.
- Backgrounds differ a lot between floors (outdoor foliage vs trunk interior).
- Signatures are recorded during the survey and shipped in `zone.json`, so players need no setup.
- It picks among the candidates from (a), or from the coordinates alone after a restart.

**c. Ask.** When (a) and (b) disagree or are unsure, the floor picker highlights the candidates and the player taps one. It is never checked automatically while unsure.

`readingValue` / `decodeText` stay as they are; they return coordinates, and a new step maps coordinates plus these signals to a map id.

## 5. Floor UI

- **Floor picker:** a Radix ToggleGroup in the zone map's corner. One entry per floor (name and "3 / 8" checked), ordered bottom to top. Only shown for zones with floors.
- **One floor drawn at a time:** the other floors' maps on the same cells show faintly, or not at all.
- **Ladders and vines:** drawn as a small icon that switches floor on click. A route step on another floor says "take the ladder to <floor>".
- **Header:** progress counts every floor. "New hunt" resets all of them.
- **Live mode:** follows the current map's floor automatically. The floating guide names the floor.
- **Routes:** run on the id graph across floors. Moving floor costs one step, like a sun.
- **Language:** the texts go in fr.ts and en.ts. Floor names come from the config, in French like map names.

## Order of work

1. **Map keys by id:** refactor, no behaviour change, existing tests green. Done in its own PR.
2. **Pipeline:** `stacked`, floors, candidates, `add_passages`. Arbre Hakam is exported with candidate links only.
3. **Floor UI:** picker, faint stacked maps, ladder icons, routes across floors.
4. **Live:** map-change detection plus transition tracking. Then the ask fallback.
5. **Survey mode and export.** Then a walk-through in game, and the passages go into the config.
6. **Visual signatures:** recorded during the survey and used in live.

Steps 1–3 can be built and checked without the game. Steps 4–6 need captures of the real zone.

## Open questions

- **Floor names:** what players call the floors (from the game or the community), and whether Tronc and Feuillage stay one zone with parts, like Souterrains d'Astrub. Proposed: one zone "Arbre Hakam" with two parts.
- **Ways in:** where the tree is entered from Otomaï, and whether the 1-map rooms at `[-55,15]` are its foot.
- **Archimonster hunting:** whether it needs every stacked map or only those with fights. Every map has fight cells, so all of them are assumed for now.
