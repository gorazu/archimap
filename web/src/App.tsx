import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FloatingGuide, FloatingWindow, FLOATING_SUPPORTED, useFloatingWindow } from "./components/FloatingGuide";
import { Header } from "./components/Header";
import { LivePanel } from "./components/LivePanel";
import { ZoneMap } from "./components/ZoneMap";
import {
  fetchZone, fetchZoneIndex, isSelection, mapKey, partOf, splitSelection, zonePart, type Zone, type ZoneSummary,
} from "./data/zones";
import {
  buildGraph, describePosition, guideFrom, planEntrances, routeProgress,
  type EntranceRoute, type Guidance, type Progress, type RouteStep, type ZoneGraph,
} from "./data/route";
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
function guideText(guidance: Guidance, progress: Progress, graph: ZoneGraph, left: number, unreachable: number) {
  const step = guidance.step;
  if (!step) {
    return {
      next: progress.nextGoal ? "Prochaine carte du parcours hors d'atteinte d'ici" : "Zone terminée !",
      rest: null,
      unreachable,
    };
  }
  const target = graph.nodes[step.to];
  const where = step.leave ? `soleil ${describePosition(step.leave)}` : "passage";
  return {
    next: `${guidance.detour ? "Retour au parcours : " : ""}${where} → [${target.x},${target.y}]`,
    rest: `${left} carte${left > 1 ? "s" : ""} à vérifier · ${guidance.remaining} déplacement${guidance.remaining > 1 ? "s" : ""}`,
    unreachable,
  };
}

/** Which entrance's route the player follows, per zone, remembered. */
function entranceKey(plan: EntranceRoute): string {
  return plan.entrance ? `${plan.entrance.x},${plan.entrance.y},${plan.entrance.area},${plan.entrance.kind}` : "free";
}

function storedEntrance(zone: string): string | null {
  try {
    return localStorage.getItem(`archimap:entrance:${zone}`);
  } catch {
    return null;
  }
}

export function App() {
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
  // A part shown alone: its maps only, its progress shared with the whole zone.
  const zone = useMemo(() => {
    const part = fullZone?.parts?.find((p) => p.part === partSlug);
    return fullZone && part ? zonePart(fullZone, part) : fullZone;
  }, [fullZone, partSlug]);

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

  const { checked, toggle, reset } = useProgress(zoneSlug ?? "");
  const store = useContext(ProgressStoreContext);

  const lookups: ZoneLookup[] = useMemo(
    () =>
      (zones ?? []).map((z) => ({
        zone: z.zone,
        subareas: z.parts ? z.parts.map((p) => p.subarea) : z.subarea ? [z.subarea] : [],
        maps: new Set(zoneData?.get(z.zone)?.maps.map((m) => mapKey(m.x, m.y))),
      })),
    [zones, zoneData],
  );
  const knownMaps = useMemo(() => new Set(lookups.flatMap((z) => [...z.maps])), [lookups]);
  const live = useLiveCapture(knownMaps);
  const [liveOpen, setLiveOpen] = useState(false);
  const { position, location: gameLocation } = live.state;
  const positionKey = position ? mapKey(position[0], position[1]) : null;
  const positionZone = positionKey ? resolveZone(positionKey, gameLocation, zoneSlug, lookups) : null;
  const shown = useMemo(() => new Set(zone?.maps.map((m) => mapKey(m.x, m.y))), [zone]);
  const current = positionZone === zoneSlug && positionKey && shown.has(positionKey) ? positionKey : null;

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
    if (lookups.find((z) => z.zone === positionZone)?.maps.has(positionKey)) {
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
  const [arrivedBy, setArrivedBy] = useState<RouteStep | null>(null);
  const lastCurrent = useRef<string | null>(null);
  const suggested = useRef<RouteStep | null>(null);
  useEffect(() => {
    if (current && current !== lastCurrent.current) {
      setPreviousMap(lastCurrent.current);
      setArrivedBy(suggested.current);
      lastCurrent.current = current;
    }
  }, [current]);

  // One route per entrance, computed once per zone. The player follows the
  // chosen one; progress along it comes from the maps checked.
  const graph = useMemo(() => (zone ? buildGraph(zone) : null), [zone]);
  const plans = useMemo(() => (zone && graph ? planEntrances(zone, graph) : null), [zone, graph]);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(slug ? storedEntrance(slug) : null), [slug]);
  const chooseEntrance = useCallback(
    (key: string) => {
      setChosen(key);
      try {
        if (slug) localStorage.setItem(`archimap:entrance:${slug}`, key);
      } catch {
        // Not important if it can't be stored.
      }
    },
    [slug],
  );
  const plan = plans?.find((p) => entranceKey(p) === chosen) ?? plans?.[0] ?? null;
  const progress = useMemo(
    () => (plan && graph ? routeProgress(plan.route, checked, graph) : null),
    [plan, graph, checked],
  );
  const guiding = (live.state.status === "running" || live.state.status === "paused") && current !== null;
  const guidance = useMemo(() => {
    if (!guiding || !plan || !progress || !graph) return null;
    // On a split map: the part the suggested sun leads to, if that's the move
    // the player made, else the parts reachable from the previous map first.
    const here = graph.nodes.flatMap((n, i) => (n.map === current ? [i] : []));
    const followed = arrivedBy && graph.nodes[arrivedBy.from]?.map === previousMap && graph.nodes[arrivedBy.to]?.map === current
      ? [arrivedBy.to] : [];
    const cameFrom = here.filter((i) => graph.nodes.some((n, j) => n.map === previousMap && graph.edges.get(j)!.has(i)));
    const order = [...new Set([...followed, ...cameFrom, ...here])];
    return guideFrom(plan.route, progress, graph, order);
  }, [guiding, plan, progress, graph, current, previousMap, arrivedBy]);
  useEffect(() => {
    suggested.current = guidance?.step ?? null;
  }, [guidance]);
  const left = zone ? zone.maps.filter((m) => !checked.has(mapKey(m.x, m.y))).length : 0;
  const guide = guidance && progress && graph && plan
    ? guideText(guidance, progress, graph, left, plan.route.unreachable.length) : null;
  const floating = useFloatingWindow();

  // Ignore stored keys for maps that are no longer in the zone.
  const checkedCount = useMemo(
    () => zone?.maps.filter((m) => checked.has(mapKey(m.x, m.y))).length ?? 0,
    [zone, checked],
  );

  // Clears the whole zone, even when showing one part of it.
  const onNewHunt = useCallback(() => {
    if (!fullZone) return;
    const count = fullZone.maps.filter((m) => checked.has(mapKey(m.x, m.y))).length;
    if (confirm(`Nouvelle chasse : décocher ${count > 1 ? `les ${count} cartes vérifiées` : "la carte vérifiée"} de « ${fullZone.name} » ?`)) {
      reset();
    }
  }, [fullZone, checked, reset]);

  return (
    <div className="app">
      <Header
        zones={zones ?? []}
        current={slug}
        onSelectZone={setSlug}
        checkedCount={checkedCount}
        total={zone?.maps.length ?? 0}
        onNewHunt={onNewHunt}
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
          <div className="message">Chargement…</div>
        ) : zones.length === 0 ? (
          <div className="message">
            <p>Aucune zone pour l'instant.</p>
            <p>
              Générez-en une avec le pipeline :<br />
              <code>uv run python -m archimap.extract video.mp4 --zone ma-zone</code>
            </p>
          </div>
        ) : zone ? (
          <ZoneMap
            zone={zone}
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
          />
        ) : null}
        {liveOpen && zone && (
          <LivePanel
            live={live}
            positionZone={positionZone ? (zones?.find((z) => z.zone === positionZone)?.name ?? null) : null}
            guide={guide}
            floating={FLOATING_SUPPORTED ? { open: floating.win !== null, onToggle: floating.win ? floating.close : floating.open } : undefined}
            onClose={() => setLiveOpen(false)}
          />
        )}
        {floating.win && zone && (
          <FloatingWindow win={floating.win}>
            <FloatingGuide
              zone={zone}
              checked={checked}
              checkedCount={checkedCount}
              active={live.state.status === "running" || live.state.status === "paused"}
              current={current}
              elsewhere={position && !current ? `[${position[0]},${position[1]}]` : null}
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
