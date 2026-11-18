import { Slider, Switch, Tooltip } from "radix-ui";
import { useEffect, useRef } from "react";
import type { LiveCapture } from "../live/useLiveCapture";

interface Props {
  live: LiveCapture;
  /** Name of the zone the current position belongs to, or null if none. */
  positionZone: string | null;
  /** Where to go next, on the shortest walk over the maps left to check. */
  guide: { next: string; rest: string | null; unreachable: number } | null;
  /** The floating guide window, when the browser has it. */
  floating?: { open: boolean; onToggle: () => void };
  onClose: () => void;
}

const STATUS_TEXT = {
  idle: "Arrêté",
  starting: "Démarrage…",
  running: "En direct",
  paused: "En pause",
  error: "Erreur",
} as const;

export function LivePanel({ live, positionZone, guide, floating, onClose }: Props) {
  const { state, options, setOptions } = live;
  const active = state.status === "running" || state.status === "paused";
  const position = state.position;

  return (
    <section className="live-panel" aria-label="Capture en direct">
      <header className="live-head">
        <span className={`live-dot ${state.status}`} aria-hidden="true" />
        <strong>{STATUS_TEXT[state.status]}</strong>
        <button type="button" className="live-close" onClick={onClose} aria-label="Fermer">
          ×
        </button>
      </header>

      {state.message && <p className={`live-message${state.status === "error" ? " error" : ""}`}>{state.message}</p>}

      <div className="live-actions">
        {!active && state.status !== "starting" && (
          <button type="button" className="button primary" onClick={live.start}>
            Démarrer la capture
          </button>
        )}
        {state.status === "running" && (
          <button type="button" className="button" onClick={live.pause}>
            Pause
          </button>
        )}
        {state.status === "paused" && (
          <button type="button" className="button" onClick={live.resume}>
            Reprendre
          </button>
        )}
        {active && (
          <button type="button" className="button" onClick={live.stop}>
            Arrêter
          </button>
        )}
        {floating && (
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger className="button" onClick={floating.onToggle} aria-pressed={floating.open}>
                {floating.open ? "Fermer la fenêtre flottante" : "Fenêtre flottante"}
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip" side="top" sideOffset={6}>
                  Une petite fenêtre toujours au premier plan, au-dessus du jeu
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        )}
      </div>

      {!active && state.status !== "starting" && (
        <div className="live-hint">
          <p>Avant de démarrer, dans Dofus Retro :</p>
          <ul>
            <li>
              activez l'option <em>interface moderne</em> ;
            </li>
            <li>placez le chat sur le côté droit de la fenêtre.</li>
          </ul>
          <p>
            Partagez ensuite la fenêtre du jeu (n'importe quelle taille). Chaque carte où vous passez est cochée
            automatiquement.
          </p>
        </div>
      )}

      {active && (
        <>
          <dl className="live-info">
            <dt>Position</dt>
            <dd>
              {position ? (
                <>
                  <strong>
                    [{position[0]},{position[1]}]
                  </strong>{" "}
                  {positionZone ? `· ${positionZone}` : "· hors des zones suivies"}
                </>
              ) : (
                "En attente d'une lecture stable…"
              )}
            </dd>
            {guide && (
              <>
                <dt>Ensuite</dt>
                <dd className="live-guide">
                  <strong>{guide.next}</strong>
                  {guide.rest && <div>{guide.rest}</div>}
                  {guide.unreachable > 0 && (
                    <div>
                      {guide.unreachable} carte{guide.unreachable > 1 ? "s" : ""} hors d'atteinte d'ici (par la surface ?)
                    </div>
                  )}
                </dd>
              </>
            )}
            <dt>Lieu</dt>
            <dd>{state.location ?? "illisible (position seule)"}</dd>
            <dt>Lecture</dt>
            <dd>
              <code>{state.readings.length ? state.readings.map((r) => r || "—").join("  |  ") : "—"}</code>
            </dd>
            <dt>Détection</dt>
            <dd>
              {state.layout ? (
                <>
                  Jeu {state.layout.game.w}×{state.layout.game.h} sur {state.layout.frame[0]}×{state.layout.frame[1]}
                  {" · "}
                  {state.layout.coordsFound ? "coordonnées trouvées" : "coordonnées : position par défaut"}
                </>
              ) : (
                "Analyse de la fenêtre…"
              )}
            </dd>
          </dl>

          {state.preview && (
            <div className="live-preview" title="Ce que lit l'OCR">
              <ImageCanvas image={state.preview.crop} />
              {state.preview.binarized.map((img, i) => (
                <ImageCanvas key={i} image={img} />
              ))}
            </div>
          )}

          <div className="live-setting">
            <span id="live-stability">Stabilité : {options.stableReads} lectures identiques</span>
            <Slider.Root
              className="slider"
              min={2}
              max={6}
              step={1}
              value={[options.stableReads]}
              onValueChange={([stableReads]) => setOptions({ ...options, stableReads, jumpReads: stableReads * 2 })}
            >
              <Slider.Track className="slider-track">
                <Slider.Range className="slider-range" />
              </Slider.Track>
              <Slider.Thumb className="slider-thumb" aria-labelledby="live-stability" />
            </Slider.Root>
          </div>
          <label className="live-check">
            <Switch.Root
              className="switch"
              checked={options.autoZone}
              onCheckedChange={(autoZone) => setOptions({ ...options, autoZone })}
            >
              <Switch.Thumb className="switch-thumb" />
            </Switch.Root>
            Changer de zone automatiquement
          </label>
          <button type="button" className="live-link" onClick={live.recalibrate}>
            Recalibrer la détection
          </button>
        </>
      )}
    </section>
  );
}

function ImageCanvas({ image }: { image: ImageData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
  }, [image]);
  return <canvas ref={ref} />;
}
