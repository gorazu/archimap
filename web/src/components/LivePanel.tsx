import { useEffect, useRef } from "react";
import { mapKey } from "../data/zones";
import type { LiveCapture } from "../live/useLiveCapture";

interface Props {
  live: LiveCapture;
  zoneMaps: ReadonlySet<string>;
  onClose: () => void;
}

const STATUS_TEXT = {
  idle: "Arrêté",
  starting: "Démarrage…",
  running: "En direct",
  paused: "En pause",
  error: "Erreur",
} as const;

export function LivePanel({ live, zoneMaps, onClose }: Props) {
  const { state, options, setOptions } = live;
  const active = state.status === "running" || state.status === "paused";
  const position = state.position;
  const inZone = position ? zoneMaps.has(mapKey(position[0], position[1])) : false;

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
          <button type="button" className="primary" onClick={live.start}>
            Démarrer la capture
          </button>
        )}
        {state.status === "running" && (
          <button type="button" onClick={live.pause}>
            Pause
          </button>
        )}
        {state.status === "paused" && (
          <button type="button" onClick={live.resume}>
            Reprendre
          </button>
        )}
        {active && (
          <button type="button" onClick={live.stop}>
            Arrêter
          </button>
        )}
      </div>

      {!active && state.status !== "starting" && (
        <p className="live-hint">
          Partagez la fenêtre Dofus Retro, avec l'option <em>interface moderne</em> activée. Chaque carte où vous
          passez est cochée automatiquement. L'image reste dans votre navigateur.
        </p>
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
                  {inZone ? "· cochée" : "· hors de cette zone"}
                </>
              ) : (
                "En attente d'une lecture stable…"
              )}
            </dd>
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

          <label className="live-setting">
            Stabilité : {options.stableReads} lectures identiques
            <input
              type="range"
              min={2}
              max={6}
              value={options.stableReads}
              onChange={(e) => {
                const stableReads = Number(e.target.value);
                setOptions({ stableReads, jumpReads: stableReads * 2 });
              }}
            />
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
