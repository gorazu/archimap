import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "./components/Header";
import { LivePanel } from "./components/LivePanel";
import { ZoneMap } from "./components/ZoneMap";
import { fetchZone, fetchZoneIndex, mapKey, type Zone, type ZoneSummary } from "./data/zones";
import { resolveZone, type ZoneLookup } from "./live/location";
import { isLiveCaptureSupported } from "./live/session";
import { useLiveCapture } from "./live/useLiveCapture";
import { ProgressStoreContext, useProgress } from "./progress/useProgress";

const LIVE_SUPPORTED = isLiveCaptureSupported();

const LAST_ZONE_KEY = "archimap:last-zone";
const SHOW_PATHS_KEY = "archimap:show-paths";

function initialShowPaths(): boolean {
  try {
    return localStorage.getItem(SHOW_PATHS_KEY) !== "false";
  } catch {
    return true;
  }
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

export function App() {
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  // Every zone is loaded up front: live capture needs them all to tell where the player is.
  const [zoneData, setZoneData] = useState<Map<string, Zone> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(initialShowPaths);
  const changeShowPaths = useCallback((show: boolean) => {
    setShowPaths(show);
    try {
      localStorage.setItem(SHOW_PATHS_KEY, String(show));
    } catch {
      // Not important if it can't be stored.
    }
  }, []);

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
            onShowPathsChange={changeShowPaths}
          />
        ) : null}
        {liveOpen && zone && (
          <LivePanel
            live={live}
            positionZone={positionZone ? (zones?.find((z) => z.zone === positionZone)?.name ?? null) : null}
            onClose={() => setLiveOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
