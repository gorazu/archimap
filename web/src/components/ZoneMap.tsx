import L from "leaflet";
import { memo, useEffect, useMemo } from "react";
import { Circle, ImageOverlay, MapContainer, Marker, Pane, Polygon, Rectangle, Tooltip, useMap, useMapEvent } from "react-leaflet";
import { TILE_HEIGHT, tileBounds, tileWidth, zoneBounds, type Bounds } from "../data/geometry";
import { drawLayout } from "../data/layout";
import { planShapes } from "../data/plan";
import { mapKey, type MapEntry, type Zone } from "../data/zones";
import type { CheckedSet } from "../progress/progressStore";

const STYLE_UNCHECKED: L.PathOptions = {
  color: "#e8d9b0", weight: 1, opacity: 0.35, fillColor: "#000", fillOpacity: 0,
};
const STYLE_INFERRED: L.PathOptions = { ...STYLE_UNCHECKED, color: "#f0a030", opacity: 0.9, dashArray: "6 4" };
const STYLE_CHECKED: L.PathOptions = {
  color: "#5fd35f", weight: 3, opacity: 1, fillColor: "#2f8f2f", fillOpacity: 0.5,
};
// Drawn tiles, like the mock zones.
const PLAN_TILE: L.PathOptions = { stroke: false, fillColor: "#2b241b", fillOpacity: 1, interactive: false };
// Light and see-through, so they stand out from the map layouts underneath.
const PLAN_CORRIDOR: L.PathOptions = { stroke: false, fillColor: "#f1e4c2", fillOpacity: 0.6, interactive: false };
const PLAN_NODE: L.PathOptions = { stroke: false, fillColor: "#f1e4c2", fillOpacity: 0.85, interactive: false };
// Leaflet stacks a pane's shapes (svg, z-index 200) above its images (1 by
// default): raise the map layouts above their tile backgrounds.
const LAYOUT_Z = 201;
/** Coordinate labels are hidden when tiles get smaller than this on screen. */
const LABEL_MIN_TILE_PX = 44;

const STYLE_CURRENT: L.PathOptions = {
  color: "#4fc3ff", weight: 5, opacity: 1, fill: false, interactive: false, className: "current-map",
};

interface Props {
  zone: Zone;
  checked: CheckedSet;
  onToggle: (key: string) => void;
  /** Map the player is on (live capture), highlighted and kept in view. */
  current?: string | null;
}

export function ZoneMap({ zone, checked, onToggle, current }: Props) {
  const bounds = useMemo(() => zoneBounds(zone.maps, zone.tile_size), [zone]);
  return (
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
      <PlanLayer zone={zone} />
      {zone.maps.map((entry) => {
        const key = mapKey(entry.x, entry.y);
        return (
          <MapTile
            key={key}
            zone={zone}
            entry={entry}
            checked={checked.has(key)}
            onToggle={onToggle}
          />
        );
      })}
      {current && <CurrentMap key={current} zone={zone} current={current} />}
    </MapContainer>
  );
}

/** Drawn tiles: a dark room per map, corridors for the passages, coordinates. */
const PlanLayer = memo(function PlanLayer({ zone }: { zone: Zone }) {
  const size = zone.tile_size;
  const shapes = useMemo(() => planShapes(zone), [zone]);
  // Drawn once per zone: an image per map is far lighter than a shape per cell.
  const layouts = useMemo(
    () =>
      zone.maps
        .filter((m) => m.layout)
        .map((m) => ({ key: mapKey(m.x, m.y), bounds: tileBounds(m.x, m.y, size), url: drawLayout(m.layout!) })),
    [zone, size],
  );
  const labels = useMemo(
    () =>
      zone.maps.map((m) => ({
        key: mapKey(m.x, m.y),
        position: [-m.y * TILE_HEIGHT - 4, m.x * tileWidth(size) + 6] as [number, number],
        icon: L.divIcon({ className: "plan-label", html: `${m.x},${m.y}`, iconSize: undefined, iconAnchor: [0, 0] }),
      })),
    [zone, size],
  );
  // Own panes under the overlay pane, so the plan always sits below the
  // clickable tiles and their checked colour. Tiles and map layouts get the
  // lowest one: Leaflet draws images above the shapes of their own pane.
  return (
    <>
      <Pane name="plan-tiles" style={{ zIndex: 340 }}>
        {zone.maps.map((m) => (
          <Rectangle key={mapKey(m.x, m.y)} bounds={tileBounds(m.x, m.y, size)} pathOptions={PLAN_TILE} />
        ))}
        {layouts.map((l) => (
          <ImageOverlay key={`layout${l.key}`} url={l.url} bounds={l.bounds} zIndex={LAYOUT_Z} />
        ))}
      </Pane>
      <Pane name="plan" style={{ zIndex: 350 }}>
        {shapes.bands.map((band, i) => (
          <Polygon key={`band${i}`} positions={band} pathOptions={PLAN_CORRIDOR} />
        ))}
        {shapes.joints.map((p, i) => (
          <Circle key={`joint${i}`} center={p} radius={TILE_HEIGHT * 0.045} pathOptions={PLAN_CORRIDOR} />
        ))}
        {shapes.nodes.map((p, i) => (
          <Circle key={`node${i}`} center={p} radius={TILE_HEIGHT * 0.07} pathOptions={PLAN_NODE} />
        ))}
        {labels.map((l) => (
          <Marker key={l.key} position={l.position} icon={l.icon} interactive={false} keyboard={false} pane="markerPane" />
        ))}
        <LabelVisibility />
      </Pane>
    </>
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
}

const MapTile = memo(function MapTile({ zone, entry, checked, onToggle }: TileProps) {
  const bounds = useMemo(() => tileBounds(entry.x, entry.y, zone.tile_size), [entry, zone.tile_size]);
  const handlers = useMemo(
    () => ({ click: () => onToggle(mapKey(entry.x, entry.y)) }),
    [entry, onToggle],
  );
  const style = checked ? STYLE_CHECKED : entry.source === "inferred" ? STYLE_INFERRED : STYLE_UNCHECKED;
  return (
    <Rectangle bounds={bounds} pathOptions={style} eventHandlers={handlers}>
      <Tooltip direction="top" offset={[0, -8]}>
        <strong>[{entry.x},{entry.y}]</strong>
        {checked ? " · vérifiée" : ""}
        {entry.source === "inferred" ? <div className="tooltip-note">Position estimée</div> : null}
      </Tooltip>
    </Rectangle>
  );
});
