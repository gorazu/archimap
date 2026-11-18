import { Slider, Switch, Tooltip } from "radix-ui";
import { useEffect, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
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

export function LivePanel({ live, positionZone, guide, floating, onClose }: Props) {
  const { state, options, setOptions } = live;
  const active = state.status === "running" || state.status === "paused";
  const position = state.position;
  const { t } = useTranslation();

  return (
    <section className="live-panel" aria-label={t("live.panel")}>
      <header className="live-head">
        <span className={`live-dot ${state.status}`} aria-hidden="true" />
        <strong>{t(`live.status.${state.status}`)}</strong>
        <button type="button" className="live-close" onClick={onClose} aria-label={t("live.close")}>
          ×
        </button>
      </header>

      {state.message && (
        <p className={`live-message${state.status === "error" ? " error" : ""}`}>
          {t(`live.message.${state.message.key}`, { detail: state.message.detail })}
        </p>
      )}

      <div className="live-actions">
        {!active && state.status !== "starting" && (
          <button type="button" className="button primary" onClick={live.start}>
            {t("live.start")}
          </button>
        )}
        {state.status === "running" && (
          <button type="button" className="button" onClick={live.pause}>
            {t("live.pause")}
          </button>
        )}
        {state.status === "paused" && (
          <button type="button" className="button" onClick={live.resume}>
            {t("live.resume")}
          </button>
        )}
        {active && (
          <button type="button" className="button" onClick={live.stop}>
            {t("live.stop")}
          </button>
        )}
        {floating && (
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger className="button" onClick={floating.onToggle} aria-pressed={floating.open}>
                {floating.open ? t("live.closeFloating") : t("live.floating")}
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip" side="top" sideOffset={6}>
                  {t("live.floatingHint")}
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        )}
      </div>

      {!active && state.status !== "starting" && (
        <div className="live-hint">
          <p>{t("live.before")}</p>
          <ul>
            <li>
              <Trans i18nKey="live.modernUi" components={[<em />]} />
            </li>
            <li>{t("live.chatRight")}</li>
          </ul>
          <p>{t("live.share")}</p>
        </div>
      )}

      {active && (
        <>
          <dl className="live-info">
            <dt>{t("live.position")}</dt>
            <dd>
              {position ? (
                <>
                  <strong>
                    [{position[0]},{position[1]}]
                  </strong>{" "}
                  {positionZone ? `· ${positionZone}` : t("live.outside")}
                </>
              ) : (
                t("live.waiting")
              )}
            </dd>
            {guide && (
              <>
                <dt>{t("live.next")}</dt>
                <dd className="live-guide">
                  <strong>{guide.next}</strong>
                  {guide.rest && <div>{guide.rest}</div>}
                  {guide.unreachable > 0 && (
                    <div>{t("guide.unreachable", { count: guide.unreachable })}</div>
                  )}
                </dd>
              </>
            )}
            <dt>{t("live.place")}</dt>
            <dd>{state.location ?? t("live.unreadable")}</dd>
            <dt>{t("live.moves")}</dt>
            <dd>{state.moves}</dd>
            <dt>{t("live.reading")}</dt>
            <dd>
              <code>{state.readings.length ? state.readings.map((r) => r || "—").join("  |  ") : "—"}</code>
            </dd>
            <dt>{t("live.detection")}</dt>
            <dd>
              {state.layout ? (
                <>
                  {t("live.game", {
                    game: `${state.layout.game.w}×${state.layout.game.h}`,
                    frame: `${state.layout.frame[0]}×${state.layout.frame[1]}`,
                  })}
                  {" · "}
                  {t(state.layout.coordsFound ? "live.coordsFound" : "live.coordsDefault")}
                </>
              ) : (
                t("live.analysing")
              )}
            </dd>
          </dl>

          {state.preview && (
            <div className="live-preview" title={t("live.ocrPreview")}>
              <ImageCanvas image={state.preview.crop} />
              {state.preview.binarized.map((img, i) => (
                <ImageCanvas key={i} image={img} />
              ))}
            </div>
          )}

          <div className="live-setting">
            <span id="live-stability">{t("live.stability", { count: options.stableReads })}</span>
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
            {t("live.autoZone")}
          </label>
          <button type="button" className="live-link" onClick={live.recalibrate}>
            {t("live.recalibrate")}
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
