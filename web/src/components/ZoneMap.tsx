import L from "leaflet";
import { RadioGroup, ToggleGroup } from "radix-ui";
import { memo, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Circle, ImageOverlay, MapContainer, Marker, Pane, Polyline, Rectangle, Tooltip, useMap, useMapEvent } from "react-leaflet";
import { TILE_HEIGHT, tileBounds, tileWidth, zoneBounds, type Bounds } from "../data/geometry";
import { drawLayout } from "../data/layout";
import { leavePoint, planShapes, routeShapes } from "../data/plan";
import type { EntranceRoute, Progress, RouteStep, ZoneGraph } from "../data/route";
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
// Light lines that stand out from the map layouts underneath: walking routes
// solid, map changes dashed. Widths in screen pixels, whatever the zoom.
const PLAN_ROUTE: L.PathOptions = {
  color: "#f1e4c2", weight: 3, opacity: 0.8, lineCap: "round", lineJoin: "round", interactive: false,
};
const PLAN_CROSSING: L.PathOptions = { ...PLAN_ROUTE, dashArray: "1 7" };
const PLAN_NODE: L.PathOptions = { stroke: false, fillColor: "#f1e4c2", fillOpacity: 0.85, interactive: false };
// The suggested walk, in the same blue as the live position.
const ROUTE_LINE: L.PathOptions = {
  color: "#4fc3ff", weight: 4, opacity: 0.9, lineCap: "round", lineJoin: "round", interactive: false,
};
const ROUTE_DONE: L.PathOptions = { ...ROUTE_LINE, opacity: 0.3 };
const NEXT_SUN: L.PathOptions = {
  color: "#4fc3ff", weight: 3, fillColor: "#ffc94d", fillOpacity: 1, interactive: false, className: "next-sun",
};
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
  /** Draw the paths (walking routes and map changes). */
  showPaths: boolean;
  onShowPathsChange: (show: boolean) => void;
  /** Draw the suggested walk through the zone. */
  showRoute: boolean;
  onShowRouteChange: (show: boolean) => void;
  /** One route per entrance, best first, and the one followed. */
  plans: EntranceRoute[] | null;
  plan: EntranceRoute | null;
  onChooseEntrance: (plan: EntranceRoute) => void;
  progress: Progress | null;
  graph: ZoneGraph | null;
  /** Live capture guiding the player: the move to make now, its sun highlighted. */
  nextStep: RouteStep | null;
}

export function ZoneMap({
  zone, checked, onToggle, current, showPaths, onShowPathsChange, showRoute, onShowRouteChange,
  plans, plan, onChooseEntrance, progress, graph, nextStep,
}: Props) {
  const bounds = useMemo(() => zoneBounds(zone.maps, zone.tile_size), [zone]);
  const { t } = useTranslation();
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
        <PlanLayer zone={zone} showPaths={showPaths} />
        {plan && graph && progress && showRoute && (
          <RouteLayer zone={zone} graph={graph} plan={plan} progress={progress} checked={checked} />
        )}
        {nextStep && graph && <NextSun point={leavePoint(zone, graph, nextStep)} />}
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
      <div className="map-controls">
        <ToggleGroup.Root
          type="multiple"
          className="map-toggles"
          aria-label={t("map.display")}
          value={[...(showPaths ? ["paths"] : []), ...(showRoute ? ["route"] : [])]}
          onValueChange={(shown) => {
            onShowPathsChange(shown.includes("paths"));
            onShowRouteChange(shown.includes("route"));
          }}
        >
          <ToggleGroup.Item value="paths">{t("map.paths")}</ToggleGroup.Item>
          <ToggleGroup.Item value="route">{t("map.route")}</ToggleGroup.Item>
        </ToggleGroup.Root>
        {showRoute && plans && plan && progress && (
          <RoutePanel plans={plans} plan={plan} progress={progress} onChoose={onChooseEntrance} />
        )}
      </div>
    </>
  );
}

/** Drawn tiles: a dark room per map, corridors for the passages, coordinates. */
const PlanLayer = memo(function PlanLayer({ zone, showPaths }: { zone: Zone; showPaths: boolean }) {
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
        {showPaths && (
          <>
            {shapes.routes.map((route, i) => (
              <Polyline key={`route${i}`} positions={route} pathOptions={PLAN_ROUTE} />
            ))}
            {shapes.crossings.map((line, i) => (
              <Polyline key={`crossing${i}`} positions={line} pathOptions={PLAN_CROSSING} />
            ))}
            {shapes.nodes.map((p, i) => (
              <Circle key={`node${i}`} center={p} radius={TILE_HEIGHT * 0.07} pathOptions={PLAN_NODE} />
            ))}
          </>
        )}
        {labels.map((l) => (
          <Marker key={l.key} position={l.position} icon={l.icon} interactive={false} keyboard={false} pane="markerPane" />
        ))}
        <LabelVisibility />
      </Pane>
    </>
  );
});

/**
 * The suggested walk: a line from sun to sun, maps numbered in visiting
 * order, the entrance marked. The part already walked (up to the last map
 * checked in order) is dimmed.
 */
function RouteLayer({ zone, graph, plan, progress, checked }: {
  zone: Zone; graph: ZoneGraph; plan: EntranceRoute; progress: Progress; checked: CheckedSet;
}) {
  const shapes = useMemo(() => routeShapes(zone, graph, plan.route, plan.entrance?.uv), [zone, graph, plan]);
  const split = shapes.arrivals[progress.fromIndex]; // where the stretch to the next goal begins
  const icons = useMemo(
    () => shapes.numbers.map((n, i) =>
      L.divIcon({
        className: `route-step${checked.has(n.map) ? " done" : ""}${i === 0 ? " entrance" : ""}`,
        html: i === 0 && plan.entrance ? "▶" : n.label,
        iconSize: [20, 20],
      }),
    ),
    [shapes, checked, plan],
  );
  return (
    <Pane name="route" style={{ zIndex: 360 }}>
      {split > 0 && <Polyline positions={shapes.line.slice(0, split + 1)} pathOptions={ROUTE_DONE} />}
      <Polyline positions={shapes.line.slice(split)} pathOptions={ROUTE_LINE} />
      {shapes.numbers.map((n, i) => (
        <Marker key={`step${i}`} position={n.position} icon={icons[i]} interactive={false} keyboard={false} pane="markerPane" />
      ))}
    </Pane>
  );
}

function NextSun({ point }: { point: [number, number] }) {
  return (
    <Pane name="next-sun" style={{ zIndex: 370 }}>
      <Circle center={point} radius={TILE_HEIGHT * 0.07} pathOptions={NEXT_SUN} />
    </Pane>
  );
}

function RoutePanel({ plans, plan, progress, onChoose }: {
  plans: EntranceRoute[]; plan: EntranceRoute; progress: Progress; onChoose: (plan: EntranceRoute) => void;
}) {
  const most = plans[0].route.order.length;
  const moves = plan.route.steps.length;
  const repeats = moves + 1 - plan.route.order.length;
  const goal = progress.nextGoal;
  const done = goal ? plan.route.order.indexOf(goal) : plan.route.order.length;
  const { t } = useTranslation();
  return (
    <div className="route-panel">
      {plans[0].entrance && (
        <div className="route-entrances">
          <div className="route-legend" id="route-entrance">{t("route.entrance")}</div>
          <RadioGroup.Root
            aria-labelledby="route-entrance"
            value={String(plans.indexOf(plan))}
            onValueChange={(i) => onChoose(plans[Number(i)])}
          >
            {plans.map((p, i) => {
              const e = p.entrance!;
              const reach = p.route.order.length;
              return (
                <label key={i} className="route-entrance">
                  <RadioGroup.Item value={String(i)} className="radio">
                    <RadioGroup.Indicator className="radio-dot" />
                  </RadioGroup.Item>
                  <span>
                    [{e.x},{e.y}] {t(`route.kind.${e.kind}`)}
                    {e.to && <small> → {e.to}</small>}
                    <br />
                    <small>
                      {reach < most ? t("route.onlyMaps", { count: reach }) : t("route.moves", { count: p.route.steps.length })}
                      {i === 0 && t("route.shortest")}
                    </small>
                  </span>
                </label>
              );
            })}
          </RadioGroup.Root>
        </div>
      )}
      <p>
        {t("route.moves", { count: moves })} · {t("route.repeats", { count: repeats })}
        <br />
        {goal ? t("route.next", { done, total: plan.route.order.length, goal }) : t("route.done")}
        {plan.route.unreachable.length > 0 && (
          <>
            <br />
            {t("route.unreachable", { count: plan.route.unreachable.length })}
          </>
        )}
      </p>
    </div>
  );
}

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
  const { t } = useTranslation();
  return (
    <Rectangle bounds={bounds} pathOptions={style} eventHandlers={handlers}>
      <Tooltip direction="top" offset={[0, -8]}>
        <strong>[{entry.x},{entry.y}]</strong>
        {checked ? t("map.checked") : ""}
        {entry.source === "inferred" ? <div className="tooltip-note">{t("map.estimated")}</div> : null}
      </Tooltip>
    </Rectangle>
  );
});
