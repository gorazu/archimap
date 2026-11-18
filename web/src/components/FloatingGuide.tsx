import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { drawLayout } from "../data/layout";
import type { RouteStep, ZoneGraph } from "../data/route";
import { mapKey, type MapEntry, type Zone } from "../data/zones";
import type { CheckedSet } from "../progress/progressStore";

// A small always-on-top window (Document Picture-in-Picture, Chrome and Edge)
// showing where to go next, for players with one screen: the game stays in
// front, the guide floats over it.

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}

function pictureInPicture(): DocumentPictureInPicture | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture ?? null;
}

export const FLOATING_SUPPORTED = typeof window !== "undefined" && pictureInPicture() !== null;

/** The floating window, if open, and a way to open or close it. */
export function useFloatingWindow() {
  const [win, setWin] = useState<Window | null>(null);
  const open = useCallback(async () => {
    const pip = pictureInPicture();
    if (!pip) return;
    if (pip.window) {
      pip.window.focus();
      return;
    }
    const next = await pip.requestWindow({ width: 360, height: 330 });
    // Same styles as the page.
    for (const sheet of document.styleSheets) {
      try {
        const style = next.document.createElement("style");
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
        next.document.head.append(style);
      } catch {
        if (sheet.href) {
          const link = next.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          next.document.head.append(link);
        }
      }
    }
    next.document.title = "Archimap";
    next.document.body.className = "floating-body";
    next.addEventListener("pagehide", () => setWin(null));
    setWin(next);
  }, []);
  const close = useCallback(() => win?.close(), [win]);
  return { win, open, close };
}

export function FloatingWindow({ win, children }: { win: Window; children: ReactNode }) {
  return createPortal(children, win.document.body);
}

interface Props {
  zone: Zone;
  checked: CheckedSet;
  checkedCount: number;
  /** Live capture running (or paused). */
  active: boolean;
  /** Map the player is on, in this zone. */
  current: string | null;
  /** Live position outside the zone shown, if any. */
  elsewhere: string | null;
  guide: { next: string; rest: string | null; unreachable: number } | null;
  nextStep: RouteStep | null;
  graph: ZoneGraph | null;
}

export function FloatingGuide({ zone, checked, checkedCount, active, current, elsewhere, guide, nextStep, graph }: Props) {
  const total = zone.maps.length;
  const { t } = useTranslation();
  return (
    <div className="floating">
      <header className="floating-head">
        <strong>{zone.name}</strong>
        <span>
          {checkedCount} / {total}
        </span>
      </header>
      {!active ? (
        <p className="floating-note">{t("floating.startCapture")}</p>
      ) : !current ? (
        <p className="floating-note">{elsewhere ? t("floating.elsewhere", { position: elsewhere }) : t("floating.waiting")}</p>
      ) : (
        <>
          {guide && (
            <div className="floating-guide">
              <strong>{guide.next}</strong>
              {guide.rest && <div>{guide.rest}</div>}
            </div>
          )}
          <MiniMap zone={zone} checked={checked} current={current} nextStep={nextStep} graph={graph} />
        </>
      )}
    </div>
  );
}

/** Layout images, drawn once per map. */
const layoutImages = new WeakMap<MapEntry, string>();
function layoutImage(m: MapEntry): string | null {
  if (!m.layout) return null;
  if (!layoutImages.has(m)) layoutImages.set(m, drawLayout(m.layout));
  return layoutImages.get(m)!;
}

const TILE_W = 120;

/** The maps around the player, with the sun to take next and where it leads. */
function MiniMap({ zone, checked, current, nextStep, graph }: {
  zone: Zone; checked: CheckedSet; current: string; nextStep: RouteStep | null; graph: ZoneGraph | null;
}) {
  const [cx, cy] = current.split(",").map(Number);
  const { t } = useTranslation();
  const [w, h] = zone.tile_size;
  const tileH = h > 0 ? (TILE_W * h) / w : TILE_W * 0.6;
  const maps = useMemo(() => new Map(zone.maps.map((m) => [mapKey(m.x, m.y), m])), [zone]);
  const at = (x: number, y: number, [u, v]: [number, number]) =>
    [(x - cx + 1 + u) * TILE_W, (y - cy + 1 + v) * tileH] as const;
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const m = maps.get(mapKey(cx + dx, cy + dy));
      if (m) tiles.push(m);
    }
  }
  let move: { from: readonly [number, number]; to: readonly [number, number] } | null = null;
  if (nextStep && graph) {
    const a = graph.nodes[nextStep.from];
    const b = graph.nodes[nextStep.to];
    // Towards the middle of the next map: clearer than the sun you arrive by.
    move = { from: at(a.x, a.y, nextStep.leave ?? [0.5, 0.5]), to: at(b.x, b.y, [0.5, 0.5]) };
  }
  return (
    <svg className="mini-map" viewBox={`0 0 ${3 * TILE_W} ${3 * tileH}`} role="img" aria-label={t("floating.around")}>
      <defs>
        <marker id="mini-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="#4fc3ff" />
        </marker>
      </defs>
      {tiles.map((m) => {
        const [x, y] = at(m.x, m.y, [0, 0]);
        const key = mapKey(m.x, m.y);
        const image = layoutImage(m);
        return (
          <g key={key}>
            <rect x={x + 1} y={y + 1} width={TILE_W - 2} height={tileH - 2} className="mini-tile" />
            {image && <image href={image} x={x + 1} y={y + 1} width={TILE_W - 2} height={tileH - 2} preserveAspectRatio="none" />}
            {checked.has(key) && <rect x={x + 1} y={y + 1} width={TILE_W - 2} height={tileH - 2} className="mini-checked" />}
            {key === current && <rect x={x + 2} y={y + 2} width={TILE_W - 4} height={tileH - 4} className="mini-current" />}
            <text x={x + 5} y={y + 13} className="mini-label">
              {m.x},{m.y}
            </text>
          </g>
        );
      })}
      {move && (
        <>
          <line x1={move.from[0]} y1={move.from[1]} x2={move.to[0]} y2={move.to[1]} className="mini-move" markerEnd="url(#mini-arrow)" />
          <circle cx={move.from[0]} cy={move.from[1]} r={7} className="mini-sun" />
        </>
      )}
    </svg>
  );
}
