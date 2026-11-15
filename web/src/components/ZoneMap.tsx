import L from "leaflet";
import { memo, useEffect, useMemo } from "react";
import { Circle, ImageOverlay, MapContainer, Marker, Pane, Rectangle, Tooltip, useMap, useMapEvent } from "react-leaflet";
import { corridorBounds, TILE_HEIGHT, tileBounds, tileCenter, tileWidth, zoneBounds, type Bounds } from "../data/geometry";
import { dataUrl, mapKey, zoneLinks, type MapEntry, type Zone } from "../data/zones";
import type { CheckedSet } from "../progress/progressStore";

const STYLE_UNCHECKED: L.PathOptions = {
  color: "#e8d9b0", weight: 1, opacity: 0.35, fillColor: "#000", fillOpacity: 0,
};
const STYLE_INFERRED: L.PathOptions = { ...STYLE_UNCHECKED, color: "#f0a030", opacity: 0.9, dashArray: "6 4" };
const STYLE_CHECKED: L.PathOptions = {
  color: "#5fd35f", weight: 3, opacity: 1, fillColor: "#2f8f2f", fillOpacity: 0.5,
};
// Plan view: drawn tiles, like the mock zones.
const PLAN_TILE: L.PathOptions = { stroke: false, fillColor: "#2b241b", fillOpacity: 1, interactive: false };
const PLAN_CORRIDOR: L.PathOptions = { stroke: false, fillColor: "#6b5a40", fillOpacity: 1, interactive: false };
const PLAN_NODE: L.PathOptions = { stroke: false, fillColor: "#8a7452", fillOpacity: 1, interactive: false };
/** Coordinate labels are hidden when tiles get smaller than this on screen. */
const LABEL_MIN_TILE_PX = 44;

export type MapView = "plan" | "photos";

const STYLE_CURRENT: L.PathOptions = {
  color: "#4fc3ff", weight: 5, opacity: 1, fill: false, interactive: false, className: "current-map",
};

interface Props {
  zone: Zone;
  checked: CheckedSet;
  onToggle: (key: string) => void;
  /** Map the player is on (live capture), highlighted and kept in view. */
  current?: string | null;
  view: MapView;
  onViewChange: (view: MapView) => void;
}

export function ZoneMap({ zone, checked, onToggle, current, view, onViewChange }: Props) {
  const bounds = useMemo(() => zoneBounds(zone.maps, zone.tile_size), [zone]);
  return (
    <>
      <MapContainer
        key={zone.zone}
        className="map"
        crs={L.CRS.Simple}
        bounds={bounds}
        boundsOptions={{ padding: [24, 24] }}
        minZoom={-4}
        maxZoom={3}
        zoomSnap={0.25}
        zoomDelta={0.5}
        wheelPxPerZoomLevel={120}
        // Quick taps on neighbouring maps would otherwise zoom in.
        doubleClickZoom={false}
        attributionControl={false}
      >
        <FitOnResize bounds={bounds} />
        {view === "plan" && <PlanLayer zone={zone} />}
        {zone.maps.map((entry) => {
          const key = mapKey(entry.x, entry.y);
          return (
            <MapTile
              key={key}
              zone={zone}
              entry={entry}
              checked={checked.has(key)}
              onToggle={onToggle}
              photo={view === "photos"}
            />
          );
        })}
        {current && <CurrentMap key={current} zone={zone} current={current} />}
      </MapContainer>
      <div className="view-toggle" role="group" aria-label="Affichage">
        {(["plan", "photos"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => onViewChange(v)}>
            {v === "plan" ? "Plan" : "Photos"}
          </button>
        ))}
      </div>
    </>
  );
}

/** Drawn tiles: a dark room per map, corridors for the passages, coordinates. */
const PlanLayer = memo(function PlanLayer({ zone }: { zone: Zone }) {
  const size = zone.tile_size;
  const links = useMemo(() => zoneLinks(zone), [zone]);
  const labels = useMemo(
    () =>
      zone.maps.map((m) => ({
        key: mapKey(m.x, m.y),
        position: [-m.y * TILE_HEIGHT - 4, m.x * tileWidth(size) + 6] as [number, number],
        icon: L.divIcon({ className: "plan-label", html: `${m.x},${m.y}`, iconSize: undefined, iconAnchor: [0, 0] }),
      })),
    [zone, size],
  );
  // Own pane under the overlay pane: toggled back on, the plan must still
  // sit below the clickable tiles and their checked colour.
  return (
    <Pane name="plan" style={{ zIndex: 350 }}>
      {zone.maps.map((m) => (
        <Rectangle key={mapKey(m.x, m.y)} bounds={tileBounds(m.x, m.y, size)} pathOptions={PLAN_TILE} />
      ))}
      {links.map(([x1, y1, x2, y2]) => (
        <Rectangle key={`${x1},${y1}-${x2},${y2}`} bounds={corridorBounds([x1, y1], [x2, y2], size)} pathOptions={PLAN_CORRIDOR} />
      ))}
      {zone.maps.map((m) => (
        <Circle key={mapKey(m.x, m.y)} center={tileCenter(m.x, m.y, size)} radius={TILE_HEIGHT * 0.16} pathOptions={PLAN_NODE} />
      ))}
      {labels.map((l) => (
        <Marker key={l.key} position={l.position} icon={l.icon} interactive={false} keyboard={false} pane="markerPane" />
      ))}
      <LabelVisibility />
    </Pane>
  );
});

/** Hide coordinate labels when tiles are too small on screen to fit them. */
function LabelVisibility() {
  const map = useMap();
  const update = () => {
    const tilePx = TILE_HEIGHT * 2 ** map.getZoom();
    map.getContainer().classList.toggle("plan-labels-hidden", tilePx < LABEL_MIN_TILE_PX);
  };
  useMapEvent("zoomend", update);
  useEffect(update);
  return null;
}

/**
 * Keep Leaflet in sync with its container's size (the header wraps on small
 * screens, phones rotate) and refit the zone until the user moves the map.
 */
function FitOnResize({ bounds }: { bounds: Bounds }) {
  const map = useMap();
  useEffect(() => {
    let userMoved = false;
    const onUserMove = () => (userMoved = true);
    map.on("dragstart zoomstart", onUserMove);
    const observer = new ResizeObserver(() => {
      map.off("zoomstart", onUserMove);
      map.invalidateSize({ pan: false });
      if (!userMoved) map.fitBounds(bounds, { padding: [24, 24], animate: false });
      map.on("zoomstart", onUserMove);
    });
    observer.observe(map.getContainer());
    return () => {
      observer.disconnect();
      map.off("dragstart zoomstart", onUserMove);
    };
  }, [map, bounds]);
  return null;
}

function CurrentMap({ zone, current }: { zone: Zone; current: string }) {
  const map = useMap();
  const bounds = useMemo(() => {
    const entry = zone.maps.find((m) => mapKey(m.x, m.y) === current);
    return entry ? tileBounds(entry.x, entry.y, zone.tile_size) : null;
  }, [zone, current]);
  useEffect(() => {
    if (!bounds) return;
    const tile = L.latLngBounds(bounds);
    if (!map.getBounds().contains(tile)) map.panTo(tile.getCenter());
  }, [map, bounds]);
  return bounds ? <Rectangle bounds={bounds} pathOptions={STYLE_CURRENT} /> : null;
}

interface TileProps {
  zone: Zone;
  entry: MapEntry;
  checked: boolean;
  onToggle: (key: string) => void;
  photo: boolean;
}

const MapTile = memo(function MapTile({ zone, entry, checked, onToggle, photo }: TileProps) {
  const bounds = useMemo(() => tileBounds(entry.x, entry.y, zone.tile_size), [entry, zone.tile_size]);
  const handlers = useMemo(
    () => ({ click: () => onToggle(mapKey(entry.x, entry.y)) }),
    [entry, onToggle],
  );
  const style = checked ? STYLE_CHECKED : entry.source === "inferred" ? STYLE_INFERRED : STYLE_UNCHECKED;
  return (
    <>
      {photo && <ImageOverlay url={dataUrl(`${zone.zone}/${entry.tile}`)} bounds={bounds} />}
      <Rectangle bounds={bounds} pathOptions={style} eventHandlers={handlers}>
        <Tooltip direction="top" offset={[0, -8]}>
          <strong>[{entry.x},{entry.y}]</strong>
          {checked ? " · vérifiée" : ""}
          {entry.source === "inferred" ? <div className="tooltip-note">Position estimée</div> : null}
        </Tooltip>
      </Rectangle>
    </>
  );
});
