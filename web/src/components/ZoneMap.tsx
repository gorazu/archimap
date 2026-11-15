import L from "leaflet";
import { memo, useEffect, useMemo } from "react";
import { ImageOverlay, MapContainer, Rectangle, Tooltip, useMap } from "react-leaflet";
import { tileBounds, zoneBounds, type Bounds } from "../data/geometry";
import { dataUrl, mapKey, type MapEntry, type Zone } from "../data/zones";
import type { CheckedSet } from "../progress/progressStore";

const STYLE_UNCHECKED: L.PathOptions = {
  color: "#e8d9b0", weight: 1, opacity: 0.35, fillColor: "#000", fillOpacity: 0,
};
const STYLE_INFERRED: L.PathOptions = { ...STYLE_UNCHECKED, color: "#f0a030", opacity: 0.9, dashArray: "6 4" };
const STYLE_CHECKED: L.PathOptions = {
  color: "#5fd35f", weight: 3, opacity: 1, fillColor: "#2f8f2f", fillOpacity: 0.5,
};

interface Props {
  zone: Zone;
  checked: CheckedSet;
  onToggle: (key: string) => void;
}

export function ZoneMap({ zone, checked, onToggle }: Props) {
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
    </MapContainer>
  );
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
    <>
      <ImageOverlay url={dataUrl(`${zone.zone}/${entry.tile}`)} bounds={bounds} />
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
