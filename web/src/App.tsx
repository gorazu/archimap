import type { TFunction } from "i18next";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FloatingGuide, FloatingWindow, FLOATING_SUPPORTED, useFloatingWindow } from "./components/FloatingGuide";
import { Header } from "./components/Header";
import { LivePanel } from "./components/LivePanel";
import { ZoneMap } from "./components/ZoneMap";
import {
  countedMaps, fetchZone, fetchZoneIndex, floorStairs, floorView, gameCoords, isSelection, landingsZone, mapKey, partOf,
  progressKey, splitSelection,
  walkableNeighbours, zonePart, type Zone, type ZoneSummary,
} from "./data/zones";
import {
  buildGraph, describePosition, guideFrom, locate, planEntrances, routeProgress,
  type EntranceRoute, type Guidance, type Progress, type RouteStep, type ZoneGraph,
} from "./data/route";
import { followMaps, nextMaps, settleBack, type Followed } from "./data/follow";
import { resolveZone, type ZoneLookup } from "./live/location";
import { isLiveCaptureSupported } from "./live/session";
import { useLiveCapture } from "./live/useLiveCapture";
import { ProgressStoreContext, useProgress } from "./progress/useProgress";

const LIVE_SUPPORTED = isLiveCaptureSupported();

const LAST_ZONE_KEY = "archimap:last-zone";
/** An on/off setting remembered in the browser. */
function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "true";
    } catch {
      return initial;
    }
  });
  const change = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Not important if it can't be stored.
      }
    },
    [key],
  );
  return [value, change];
}

function rememberZone(slug: string) {
  try {
    localStorage.setItem(LAST_ZONE_KEY, slug);
  } catch {
    // Not important if it can't be stored.
  }
}

function initialZone(zones: ZoneSummary[]): string | null {
  const fromHash = decodeURIComponent(location.hash.slice(1));
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_ZONE_KEY);
  } catch {
    // Ignore blocked storage.
  }
  for (const slug of [fromHash, last]) {
    if (slug && isSelection(zones, slug)) return slug;
  }
  return zones[0]?.zone ?? null;
}

/** The live guide's lines: which sun to click next, and what's left. */
function guideText(
  t: TFunction, guidance: Guidance, progress: Progress, graph: ZoneGraph, left: number, unreachable: number,
  shownAt: (key: string) => string,
) {
  const step = guidance.step;
  if (!step) {
    return { next: t(progress.nextGoal ? "guide.goalUnreachable" : "guide.zoneDone"), rest: null, unreachable };
  }
  const target = graph.nodes[step.to];
  const where = step.leave
    ? t("guide.sun", { where: t(`guide.position.${describePosition(step.leave)}`) })
    : t("guide.passage");
  return {
    next: `${guidance.detour ? t("guide.back") : ""}${where} → [${shownAt(target.map)}]`,
    rest: `${t("guide.left", { count: left })} · ${t("guide.remaining", { count: guidance.remaining })}`,
    unreachable,
  };
}

/** Which entrance's route the player follows, per zone, remembered. */
function entranceKey(plan: EntranceRoute): string {
  return plan.entrance ? `${plan.entrance.x},${plan.entrance.y},${plan.entrance.area},${plan.entrance.kind}` : "free";
}

/** The landing shown in each zone of landings, remembered. */
function storedFloor(zone: string): number {
  try {
    return Number(localStorage.getItem(`archimap:floor:${zone}`)) || 0;
  } catch {
    return 0;
  }
}

function useStoredFloors(): [(zone: string) => number, (zone: string, floor: number) => void] {
  const [floors, setFloors] = useState<Record<string, number>>({});
  const floorOf = useCallback((zone: string) => floors[zone] ?? storedFloor(zone), [floors]);
  const setFloor = useCallback((zone: string, floor: number) => {
    setFloors((all) => ({ ...all, [zone]: floor }));
    try {
      localStorage.setItem(`archimap:floor:${zone}`, String(floor));
    } catch {
      // Not important if it can't be stored.
    }
  }, []);
  return [floorOf, setFloor];
}

function storedEntrance(zone: string): string | null {
  try {
    return localStorage.getItem(`archimap:entrance:${zone}`);
  } catch {
    return null;
  }
}

export function App() {
  const { t } = useTranslation();
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  // The zone picked, or one part of it: "zone/part".
  const [slug, setSlug] = useState<string | null>(null);
  // Every zone is loaded up front: live capture needs them all to tell where the player is.
  const [zoneData, setZoneData] = useState<Map<string, Zone> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useStoredFlag("archimap:show-paths", true);
  const [showRoute, setShowRoute] = useStoredFlag("archimap:show-route", false);

  useEffect(() => {
    fetchZoneIndex()
      .then(async (list) => {
        const loaded = await Promise.all(list.map((z) => fetchZone(z.zone)));
        setZoneData(new Map(loaded.map((z) => [z.zone, z])));
        setZones(list);
        setSlug(initialZone(list));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const { zone: zoneSlug, part: partSlug } = slug ? splitSelection(slug) : { zone: null, part: null };
  const fullZone = (zoneSlug && zoneData?.get(zoneSlug)) || null;
  // A zone of landings shows one landing at a time, but routes and live
  // capture go over the whole of it laid out flat, stairs included.
  const tree = useMemo(() => (fullZone?.floors ? landingsZone(fullZone) : null), [fullZone]);
  const stacked = tree !== null;
  const [floorOf, setFloorOf] = useStoredFloors();
  const floors = fullZone?.floors ?? null;
  const floor = floors && zoneSlug ? Math.min(floorOf(zoneSlug), floors.length - 1) : 0;
  // A part shown alone: its maps only, its progress shared with the whole zone.
  const zone = useMemo(() => {
    if (tree) return floorView(tree, floor);
    const part = fullZone?.parts?.find((p) => p.part === partSlug);
    return fullZone && part ? zonePart(fullZone, part) : fullZone;
  }, [fullZone, partSlug, floor, tree]);
  // What routes and live capture go over: the whole zone of landings, or the zone shown.
  const routeZone = tree ?? zone;
  // Where maps are stacked, the key a map's progress is saved under (its id too).
  const view = useMemo(
    () => new Map(routeZone?.maps.map((m) => [mapKey(m.x, m.y), fullZone ? progressKey(fullZone, m) : mapKey(m.x, m.y)])),
    [routeZone, fullZone],
  );

  // Follow #zone links to another zone without a reload.
  useEffect(() => {
    const onHash = () => {
      const target = decodeURIComponent(location.hash.slice(1));
      if (zones && isSelection(zones, target)) setSlug(target);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [zones]);

  useEffect(() => {
    if (!slug) return;
    history.replaceState(null, "", `#${slug.split("/").map(encodeURIComponent).join("/")}`);
    rememberZone(slug);
  }, [slug]);

  const { checked: saved, toggle: toggleSaved, reset } = useProgress(zoneSlug ?? "");
  const store = useContext(ProgressStoreContext);
  // The maps shown, checked, by their view key.
  const checked = useMemo(
    () => (stacked ? new Set([...view].filter(([, key]) => saved.has(key)).map(([k]) => k)) : saved),
    [stacked, view, saved],
  );
  const toggle = useCallback((key: string) => toggleSaved(view.get(key) ?? key), [toggleSaved, view]);

  const lookups: ZoneLookup[] = useMemo(
    () =>
      (zones ?? []).map((z) => ({
        zone: z.zone,
        subareas: z.parts ? z.parts.map((p) => p.subarea) : z.subareas ?? (z.subarea ? [z.subarea] : []),
        maps: new Set(zoneData?.get(z.zone)?.maps.map((m) => mapKey(m.x, m.y))),
      })),
    [zones, zoneData],
  );
  const knownMaps = useMemo(() => new Set(lookups.flatMap((z) => [...z.maps])), [lookups]);
  const around = useMemo(
    () => ({ zoneMaps: knownMaps, neighbours: walkableNeighbours([...(zoneData?.values() ?? [])]) }),
    [knownMaps, zoneData],
  );
  const live = useLiveCapture(around);
  const [liveOpen, setLiveOpen] = useState(false);
  const { position, location: gameLocation } = live.state;
  const positionKey = position ? mapKey(position[0], position[1]) : null;
  const positionZone = positionKey ? resolveZone(positionKey, gameLocation, zoneSlug, lookups) : null;
  // One route per entrance, computed once per zone. The player follows the
  // chosen one; progress along it comes from the maps checked.
  const graph = useMemo(() => (routeZone ? buildGraph(routeZone) : null), [routeZone]);
  // The map the player is on, by its key in routeZone. Where maps are stacked,
  // the maps they can be on are followed from arrival to arrival, along the
  // zone's passages and stairs, until one is left.
  const next = useMemo(() => (graph ? nextMaps(graph) : null), [graph]);
  // Arrivals since the last map known for sure: earlier ones in doubt are
  // settled once one is (see settleBack).
  const [trail, setTrail] = useState<Followed[]>([]);
  const movesBefore = useRef(0);
  const seenArrival = useRef<unknown>(null);
  useEffect(() => setTrail([]), [zoneSlug]);
  const { arrival } = live.state;
  useEffect(() => {
    if (!arrival || arrival === seenArrival.current || !routeZone || !next) return;
    // Not in the zone shown (yet): kept for when it's switched to the player's zone.
    if (positionZone !== zoneSlug) return setTrail([]);
    seenArrival.current = arrival;
    // The count starts over with each capture.
    if (arrival.moves < movesBefore.current) movesBefore.current = 0;
    const moves = arrival.moves - movesBefore.current;
    movesBefore.current = arrival.moves;
    setTrail((before) => {
      const maybe = followMaps(routeZone, next, before.at(-1)?.maybe ?? [], { position: arrival.position, moves });
      // Once a map is known for sure, the arrivals before it don't matter any more.
      return [...(before.at(-1)?.maybe.length === 1 ? before.slice(-1) : before), { maybe, moves }];
    });
  }, [arrival, positionZone, zoneSlug, routeZone, next]);
  // Before any arrival in this zone: the maps at the coordinates read.
  const maybe =
    trail.at(-1)?.maybe ??
    (position && routeZone && next ? followMaps(routeZone, next, [], { position, moves: 0 }) : []);
  const followed = maybe.length === 1 && positionZone === zoneSlug ? maybe[0] : null;
  const followedMap = useMemo(
    () => (tree && followed ? tree.maps.find((m) => mapKey(m.x, m.y) === followed) ?? null : null),
    [tree, followed],
  );
  // Highlighted on a zone of landings when it's on the landing shown.
  const current = stacked && followedMap?.floor !== floor ? null : followed;
  useEffect(() => {
    if (!followed) return;
    if (!followedMap || !zoneSlug || !fullZone || !tree || !next) return;
    // Stacked maps are only checked once told apart, with those walked
    // through while in doubt; their landing is then shown.
    for (const key of [followed, ...settleBack(next, trail)]) {
      const m = tree.maps.find((m) => mapKey(m.x, m.y) === key);
      if (m && (m.floor === undefined || fullZone.floors?.[m.floor]?.check !== false)) {
        store.set(zoneSlug, progressKey(fullZone, m), true);
      }
    }
    if (followedMap.floor !== undefined && live.options.autoZone) setFloorOf(zoneSlug, followedMap.floor);
  }, [followed, followedMap, trail, next, tree, zoneSlug, fullZone, store, live.options.autoZone, setFloorOf]);

  // Check the map the player is on, in its own zone, and follow them into
  // another zone. Only once per position: picking a zone by hand during a
  // capture isn't undone until the player moves. Showing one part of a
  // zone, follow them into its other parts too.
  const handled = useRef("");
  useEffect(() => {
    if (!positionKey || !positionZone) return;
    const step = `${positionZone}|${positionKey}`;
    if (step === handled.current) return;
    handled.current = step;
    // Stacked maps are checked once told apart (see current).
    if (!zoneData!.get(positionZone)!.floors && lookups.find((z) => z.zone === positionZone)?.maps.has(positionKey)) {
      store.set(positionZone, positionKey, true);
    }
    const part = partSlug ? partOf(zoneData!.get(positionZone)!, positionKey) : null;
    const target = part ? `${positionZone}/${part.part}` : positionZone;
    if (target !== slug && (positionZone !== zoneSlug || part) && live.options.autoZone) setSlug(target);
  }, [positionKey, positionZone, lookups, store, slug, zoneSlug, partSlug, zoneData, live.options.autoZone]);

  // The map the live player was on before the current one, and the move the
  // guide had suggested from there: on a split map, they tell which part
  // the player came in by.
  const [previousMap, setPreviousMap] = useState<string | null>(null);
  const [previousParts, setPreviousParts] = useState<number[]>([]);
  const [arrivedBy, setArrivedBy] = useState<RouteStep | null>(null);
  const lastCurrent = useRef<string | null>(null);
  const suggested = useRef<RouteStep | null>(null);
  const located = useRef<number[]>([]);
  useEffect(() => {
    if (followed && followed !== lastCurrent.current) {
      setPreviousMap(lastCurrent.current);
      setPreviousParts(located.current);
      setArrivedBy(suggested.current);
      lastCurrent.current = followed;
    }
  }, [followed]);

  // One route over the whole zone, landings and stairs included.
  const plans = useMemo(() => (routeZone && graph ? planEntrances(routeZone, graph) : null), [routeZone, graph]);
  const routeKey = slug;
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(routeKey ? storedEntrance(routeKey) : null), [routeKey]);
  const chooseEntrance = useCallback(
    (key: string) => {
      setChosen(key);
      try {
        if (routeKey) localStorage.setItem(`archimap:entrance:${routeKey}`, key);
      } catch {
        // Not important if it can't be stored.
      }
    },
    [routeKey],
  );
  const plan = plans?.find((p) => entranceKey(p) === chosen) ?? plans?.[0] ?? null;
  const progress = useMemo(
    () => (plan && graph ? routeProgress(plan.route, checked, graph) : null),
    [plan, graph, checked],
  );
  const guiding = (live.state.status === "running" || live.state.status === "paused") && followed !== null;
  // The part of the current map the player is on, as far as can be told.
  const parts = useMemo(
    () => (guiding && graph && followed ? locate(graph, followed, previousMap, previousParts, arrivedBy) : []),
    [guiding, graph, followed, previousMap, previousParts, arrivedBy],
  );
  const guidance = useMemo(
    () => (plan && progress && graph && parts.length ? guideFrom(plan.route, progress, graph, parts) : null),
    [plan, progress, graph, parts],
  );
  useEffect(() => {
    located.current = parts;
    suggested.current = guidance?.step ?? null;
  }, [guidance]);
  const left = routeZone ? countedMaps(routeZone).filter((m) => !checked.has(mapKey(m.x, m.y))).length : 0;
  const guide = guidance && progress && graph && plan
    ? guideText(t, guidance, progress, graph, left, plan.route.unreachable.length, (key) => {
      const m = routeZone?.maps.find((m) => mapKey(m.x, m.y) === key);
      return m ? gameCoords(m).join(",") : key;
    }) : null;
  const floating = useFloatingWindow();

  // Ignore stored keys for maps that are no longer in the zone.
  const tallied = useMemo(() => (fullZone?.floors ? countedMaps(fullZone) : zone?.maps ?? []), [fullZone, zone]);
  const checkedCount = useMemo(
    () => (fullZone ? tallied.filter((m) => saved.has(progressKey(fullZone, m))).length : 0),
    [fullZone, tallied, saved],
  );
  const floorChecked = useMemo(
    () => (fullZone && floors ? floors.map((_, n) => fullZone.maps.filter((m) => m.floor === n && saved.has(progressKey(fullZone, m))).length) : []),
    [fullZone, floors, saved],
  );
  const stairs = useMemo(() => (tree ? floorStairs(tree, floor) : []), [tree, floor]);

  // A new hunt clears the whole zone, even when showing one part of it.
  const huntCount = useMemo(
    () => (fullZone ? countedMaps(fullZone).filter((m) => saved.has(progressKey(fullZone, m))).length : 0),
    [fullZone, saved],
  );

  return (
    <div className="app">
      <Header
        zones={zones ?? []}
        current={slug}
        onSelectZone={setSlug}
        checkedCount={checkedCount}
        total={tallied.length}
        newHunt={{ zoneName: fullZone?.name ?? "", count: huntCount, onConfirm: reset }}
        live={
          LIVE_SUPPORTED
            ? { status: live.state.status, open: liveOpen, onToggle: () => setLiveOpen((open) => !open) }
            : undefined
        }
      />
      <main className="main">
        {error ? (
          <div className="message error">{error}</div>
        ) : zones === null || (slug && !zone) ? (
          <div className="message">{t("app.loading")}</div>
        ) : zones.length === 0 ? (
          <div className="message">
            <p>{t("app.noZones")}</p>
            <p>
              {t("app.generate")}
              <br />
              <code>uv run python -m archimap.extract video.mp4 --zone ma-zone</code>
            </p>
          </div>
        ) : zone ? (
          <ZoneMap
            zone={zone}
            routeZone={routeZone ?? zone}
            checked={checked}
            onToggle={toggle}
            current={current}
            showPaths={showPaths}
            onShowPathsChange={setShowPaths}
            showRoute={showRoute}
            onShowRouteChange={setShowRoute}
            plans={plans}
            plan={plan}
            onChooseEntrance={(p: EntranceRoute) => chooseEntrance(entranceKey(p))}
            progress={progress}
            graph={graph}
            nextStep={guidance?.step ?? null}
            floor={
              floors && zoneSlug
                ? { floors, current: floor, checked: floorChecked, stairs, onChange: (n: number) => setFloorOf(zoneSlug, n) }
                : undefined
            }
          />
        ) : null}
        {liveOpen && zone && (
          <LivePanel
            live={live}
            landings={
              stacked && positionZone === zoneSlug
                ? [...new Set(maybe.map((k) => tree!.maps.find((m) => mapKey(m.x, m.y) === k)?.floor ?? -1))].sort((a, b) => a - b)
                : null
            }
            positionZone={positionZone ? (zones?.find((z) => z.zone === positionZone)?.name ?? null) : null}
            guide={guide}
            floating={FLOATING_SUPPORTED ? { open: floating.win !== null, onToggle: floating.win ? floating.close : floating.open } : undefined}
            onClose={() => setLiveOpen(false)}
          />
        )}
        {floating.win && zone && (
          <FloatingWindow win={floating.win}>
            <FloatingGuide
              zone={routeZone ?? zone}
              checked={checked}
              checkedCount={checkedCount}
              active={live.state.status === "running" || live.state.status === "paused"}
              current={followed}
              elsewhere={position && !followed ? `[${position[0]},${position[1]}]` : null}
              guide={guide}
              nextStep={guidance?.step ?? null}
              graph={graph}
            />
          </FloatingWindow>
        )}
      </main>
    </div>
  );
}
