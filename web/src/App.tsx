import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { ZoneMap } from "./components/ZoneMap";
import { fetchZone, fetchZoneIndex, mapKey, type Zone, type ZoneSummary } from "./data/zones";
import { useProgress } from "./progress/useProgress";

const LAST_ZONE_KEY = "archimap:last-zone";

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
  const [zone, setZone] = useState<Zone | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchZoneIndex()
      .then((list) => {
        setZones(list);
        setSlug(initialZone(list));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setZone(null);
    setError(null);
    history.replaceState(null, "", `#${encodeURIComponent(slug)}`);
    rememberZone(slug);
    fetchZone(slug)
      .then((z) => !cancelled && setZone(z))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const { checked, toggle, reset } = useProgress(slug ?? "");

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
          <ZoneMap zone={zone} checked={checked} onToggle={toggle} />
        ) : null}
      </main>
    </div>
  );
}
