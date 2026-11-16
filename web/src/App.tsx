import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "./components/Header";
import { LivePanel } from "./components/LivePanel";
import { ZoneMap } from "./components/ZoneMap";
import { fetchZone, fetchZoneIndex, mapKey, type Zone, type ZoneSummary } from "./data/zones";
import { buildGraph, describePosition, planRoute, type Route, type ZoneGraph } from "./data/route";
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
    if (slug && zones.some((z) => z.zone === slug)) return slug;
  }
  return zones[0]?.zone ?? null;
}

/** The live guide's lines: which sun to click next, and what's left. */
function guideText(route: Route, graph: ZoneGraph, remaining: number) {
  const next = route.steps[0];
  const unreachable = route.unreachable.length;
  if (!next) {
    return { next: remaining === 0 ? "Zone terminée !" : "Plus aucune carte accessible d'ici", rest: null, unreachable };
  }
  const target = graph.nodes[next.to];
  const where = next.leave ? `soleil ${describePosition(next.leave)}` : "passage";
  return {
    next: `${where} → [${target.x},${target.y}]`,
    rest: `${remaining} carte${remaining > 1 ? "s" : ""} à vérifier · ${route.steps.length} déplacement${route.steps.length > 1 ? "s" : ""}`,
    unreachable,
  };
}

export function App() {
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
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
  const zone = (slug && zoneData?.get(slug)) || null;

  // Follow #zone links to another zone without a reload.
  useEffect(() => {
    const onHash = () => {
      const target = decodeURIComponent(location.hash.slice(1));
      if (zones?.some((z) => z.zone === target)) setSlug(target);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [zones]);

  useEffect(() => {
    if (!slug) return;
    history.replaceState(null, "", `#${encodeURIComponent(slug)}`);
    rememberZone(slug);
  }, [slug]);

  const { checked, toggle, reset } = useProgress(slug ?? "");
  const store = useContext(ProgressStoreContext);

  const lookups: ZoneLookup[] = useMemo(
    () =>
      (zones ?? []).map((z) => ({
        zone: z.zone,
        subarea: z.subarea,
        maps: new Set(zoneData?.get(z.zone)?.maps.map((m) => mapKey(m.x, m.y))),
      })),
    [zones, zoneData],
  );
  const knownMaps = useMemo(() => new Set(lookups.flatMap((z) => [...z.maps])), [lookups]);
  const live = useLiveCapture(knownMaps);
  const [liveOpen, setLiveOpen] = useState(false);
  const { position, location: gameLocation } = live.state;
  const positionKey = position ? mapKey(position[0], position[1]) : null;
  const positionZone = positionKey ? resolveZone(positionKey, gameLocation, slug, lookups) : null;
  const current = positionZone === slug ? positionKey : null;

  // Check the map the player is on, in its own zone, and follow them into
  // another zone. Only once per position: picking a zone by hand during a
  // capture isn't undone until the player moves.
  const handled = useRef("");
  useEffect(() => {
    if (!positionKey || !positionZone) return;
    const step = `${positionZone}|${positionKey}`;
    if (step === handled.current) return;
    handled.current = step;
    if (lookups.find((z) => z.zone === positionZone)?.maps.has(positionKey)) {
      store.set(positionZone, positionKey, true);
    }
    if (positionZone !== slug && live.options.autoZone) setSlug(positionZone);
  }, [positionKey, positionZone, lookups, store, slug, live.options.autoZone]);

  // The map the live player was on before the current one: on a split map,
  // it tells which part they came in by.
  const [previousMap, setPreviousMap] = useState<string | null>(null);
  const lastCurrent = useRef<string | null>(null);
  useEffect(() => {
    if (current && current !== lastCurrent.current) {
      setPreviousMap(lastCurrent.current);
      lastCurrent.current = current;
    }
  }, [current]);

  // Shortest walk over the maps not checked yet: from the live position when
  // capturing (guiding the player sun by sun), else from the best start.
  const graph = useMemo(() => (zone ? buildGraph(zone) : null), [zone]);
  const toVisit = useMemo(
    () => new Set(zone?.maps.map((m) => mapKey(m.x, m.y)).filter((key) => !checked.has(key))),
    [zone, checked],
  );
  const guiding = (live.state.status === "running" || live.state.status === "paused") && current !== null;
  const route = useMemo(() => {
    if (!graph) return null;
    if (guiding) {
      const here = graph.nodes.flatMap((n, i) => (n.map === current ? [i] : []));
      const cameFrom = here.filter((i) => [...graph.edges.get(i)!.keys()].some((j) => graph.nodes[j].map === previousMap));
      return planRoute(graph, toVisit, cameFrom.length ? cameFrom : here);
    }
    return showRoute && toVisit.size ? planRoute(graph, toVisit) : null;
  }, [graph, guiding, current, previousMap, toVisit, showRoute]);

  // Ignore stored keys for maps that are no longer in the zone.
  const checkedCount = useMemo(
    () => zone?.maps.filter((m) => checked.has(mapKey(m.x, m.y))).length ?? 0,
    [zone, checked],
  );

  const onNewHunt = useCallback(() => {
    if (zone && confirm(
      `Nouvelle chasse : décocher ${checkedCount > 1 ? `les ${checkedCount} cartes vérifiées` : "la carte vérifiée"} de « ${zone.name} » ?`,
    )) {
      reset();
    }
  }, [zone, checkedCount, reset]);

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
            route={route}
            graph={graph}
            guiding={guiding}
          />
        ) : null}
        {liveOpen && zone && (
          <LivePanel
            live={live}
            positionZone={positionZone ? (zones?.find((z) => z.zone === positionZone)?.name ?? null) : null}
            guide={guiding && route && graph ? guideText(route, graph, toVisit.size) : null}
            onClose={() => setLiveOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
