// Live capture loop: screen-capture the Dofus window, find the layout, read
// the coordinates with Tesseract.js and confirm positions. Everything runs in
// the browser; frames never leave it.
import { createWorker, PSM, type Worker } from "tesseract.js";
import { minChannel, resizeBicubic, toGray, type Box, type RgbaImage } from "./image";
import {
  coordsBoxFromLabel,
  defaultCoordsBox,
  detectGameArea,
  frameEdges,
  isDistinct,
  isLoadingFrame,
  labelRegion,
  labelScale,
  LABEL_THRESHOLD,
  type FrameEdges,
  type OcrWord,
} from "./layout";
import { parseLocation } from "./location";
import { binarize, decodeText, readingValue, TEXT_VARIANTS, type Coords, type Surroundings } from "./ocr";
import { Ticker } from "./ticker";
import { PositionTracker, type TrackerOptions } from "./tracker";

export type LiveStatus = "idle" | "starting" | "running" | "paused" | "error";

export interface LiveLayout {
  frame: [number, number];
  game: Box;
  coords: Box;
  coordsFound: boolean;
  /** Distinct frames used so far for the game-area borders. */
  samples: number;
}

export interface LiveState {
  status: LiveStatus;
  message: string | null;
  layout: LiveLayout | null;
  /** Raw OCR text per binarization, from the last capture. */
  readings: string[];
  position: Coords | null;
  /** Sub-area from the game's location line, or null when it can't be read. */
  location: string | null;
  /** What OCR saw last: the coordinates crop and each binarization. */
  preview: { crop: ImageData; binarized: ImageData[] } | null;
}

export const IDLE_STATE: LiveState = {
  status: "idle",
  message: null,
  layout: null,
  readings: [],
  position: null,
  preview: null,
  location: null,
};

const TICK_MS = 400;
const LAYOUT_SAMPLES = 12;
const LAYOUT_SAMPLE_MS = 1000;
/** The top-left corner (location line, and the label until found) is read this often. */
const TOP_LEFT_MS = 1500;
/** A location stays valid this long when a read fails, so OCR hiccups don't flicker it. */
const LOCATION_TTL_MS = 5000;

export function isLiveCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = canvas(img.width, img.height);
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

function toImageData(img: RgbaImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

export class LiveSession {
  private state: LiveState = IDLE_STATE;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private frame: HTMLCanvasElement | null = null;
  private digits: Worker | null = null;
  private words: Worker | null = null;
  private ticker: Ticker | null = null;
  private cancelTick: (() => void) | null = null;
  /** The check in progress, so stopping can wait for its OCR jobs to end. */
  private busy: Promise<void> = Promise.resolve();
  private tracker = new PositionTracker();
  private around: Surroundings = { zoneMaps: new Set(), neighbours: new Map() };

  private edges: FrameEdges[] = [];
  private game: Box | null = null;
  private coords: Box | null = null;
  private coordsFound = false;
  private lastSample = 0;
  private lastTopLeft = 0;
  private lastLocationAt = 0;

  constructor(private onState: (state: LiveState) => void) {}

  setOptions(options: TrackerOptions) {
    this.tracker.setOptions(options);
  }

  setSurroundings(around: Surroundings) {
    this.around = around;
  }

  async start() {
    if (this.state.status !== "idle" && this.state.status !== "error") return;
    this.update({ ...IDLE_STATE, status: "starting", message: "Choisissez la fenêtre Dofus Retro…" });
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5 } }, audio: false });
    } catch {
      this.update({ ...IDLE_STATE, message: "Capture annulée." });
      return;
    }
    this.stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop());
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    try {
      this.update({ message: "Chargement de l'OCR…" });
      [this.digits, this.words] = await Promise.all([createWorker("eng"), createWorker("eng")]);
      await this.digits.setParameters({
        tessedit_char_whitelist: "-0123456789,",
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      });
      await this.words.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    } catch (e) {
      this.fail(`Impossible de charger l'OCR : ${(e as Error).message}`);
      return;
    }
    if (!this.stream) return; // Stopped while loading.
    this.update({ status: "running", message: null });
    this.ticker = new Ticker();
    this.schedule();
  }

  stop() {
    this.cancelTick?.();
    this.cancelTick = null;
    this.ticker?.close();
    this.ticker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    // Terminating a worker mid-job crashes inside Tesseract.js: wait for the check first.
    const workers = [this.digits, this.words];
    this.digits = this.words = null;
    void this.busy.finally(() => workers.forEach((w) => void w?.terminate()));
    this.resetLayout();
    this.tracker.reset();
    this.update({ ...IDLE_STATE });
  }

  pause() {
    if (this.state.status === "running") this.update({ status: "paused" });
  }

  resume() {
    if (this.state.status === "paused") this.update({ status: "running" });
  }

  /** Forget the detected layout and find it again from the next frames. */
  recalibrate() {
    this.resetLayout();
    this.update({ layout: null });
  }

  private resetLayout() {
    this.edges = [];
    this.game = this.coords = null;
    this.coordsFound = false;
    this.lastSample = this.lastTopLeft = 0;
  }

  private update(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private fail(message: string) {
    this.stop();
    this.update({ status: "error", message });
  }

  private schedule() {
    if (!this.ticker) return;
    this.cancelTick = this.ticker.after(TICK_MS, async () => {
      try {
        if (this.state.status === "running") {
          this.busy = this.tick();
          await this.busy;
        }
      } catch (e) {
        console.error(e);
      }
      if (this.stream) this.schedule();
    });
  }

  private async tick() {
    const video = this.video;
    if (!video || !video.videoWidth) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!this.frame || this.frame.width !== w || this.frame.height !== h) {
      // First frame, or the window was resized: start the layout over.
      this.frame = canvas(w, h);
      this.resetLayout();
    }
    const ctx = this.frame.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    const now = performance.now();

    if (this.edges.length < LAYOUT_SAMPLES && now - this.lastSample > LAYOUT_SAMPLE_MS) {
      this.lastSample = now;
      this.sampleLayout(ctx.getImageData(0, 0, w, h));
    }
    if (!this.game || !this.coords) return;
    if (now - this.lastTopLeft > TOP_LEFT_MS) {
      this.lastTopLeft = now;
      await this.readTopLeft(ctx, now);
      if (!this.stream) return;
    }
    await this.readCoords(ctx);
  }

  private sampleLayout(image: ImageData) {
    const edges = frameEdges(toGray(image));
    if (isLoadingFrame(edges) || !isDistinct(edges, this.edges)) return;
    this.edges.push(edges);
    const game = detectGameArea(this.edges);
    if (!this.game || game.w !== this.game.w || game.h !== this.game.h) {
      // The coordinates box depends on the game area: find the label again.
      this.coords = defaultCoordsBox(game);
      this.coordsFound = false;
      this.lastTopLeft = 0;
    }
    this.game = game;
    this.publishLayout();
  }

  /** OCR the top-left corner: the location line, and the coordinates label until found. */
  private async readTopLeft(ctx: CanvasRenderingContext2D, now: number) {
    const game = this.game!;
    const region = labelRegion(game);
    const scale = labelScale(game);
    const level = minChannel(ctx.getImageData(region.x, region.y, region.w, region.h));
    const big = resizeBicubic(level, Math.round(level.width * scale), Math.round(level.height * scale));
    const data = new Uint8ClampedArray(big.width * big.height * 4);
    for (let i = 0; i < big.data.length; i++) {
      const v = big.data[i] > LABEL_THRESHOLD ? 0 : 255;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    const worker = this.words;
    if (!worker) return;
    const result = await worker.recognize(toCanvas({ width: big.width, height: big.height, data }), {}, { blocks: true });
    const lines = (result.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
    const location = parseLocation(lines.map((l) => l.text));
    if (location) {
      this.lastLocationAt = now;
      if (location !== this.state.location) this.update({ location });
    } else if (this.state.location && now - this.lastLocationAt > LOCATION_TTL_MS) {
      this.update({ location: null });
    }
    if (this.coordsFound) return;
    const words: OcrWord[] = lines.flatMap((l) => l.words.map((wd) => ({ text: wd.text, bbox: wd.bbox })));
    const found = coordsBoxFromLabel(words, region, scale);
    if (found) {
      this.coords = found;
      this.coordsFound = true;
      this.publishLayout();
    }
  }

  private async readCoords(ctx: CanvasRenderingContext2D) {
    const box = this.coords!;
    const crop = ctx.getImageData(box.x, box.y, box.w, box.h);
    const binarized = TEXT_VARIANTS.map(([threshold, thicken]) => binarize(crop, threshold, thicken));
    const texts: string[] = [];
    for (const img of binarized) {
      const digits = this.digits;
      if (!digits) return; // Stopped mid-check.
      const { data } = await digits.recognize(toCanvas(img));
      texts.push(data.text.replace(/\s+/g, ""));
    }
    const current = this.tracker.current;
    const value = readingValue(
      texts.map((t) => decodeText(t, current, this.around)),
      current,
      this.around.zoneMaps,
    );
    this.tracker.push(value);
    this.update({
      readings: texts,
      position: this.tracker.current,
      preview: { crop, binarized: binarized.map(toImageData) },
    });
  }

  private publishLayout() {
    if (!this.game || !this.coords || !this.frame) return;
    this.update({
      layout: {
        frame: [this.frame.width, this.frame.height],
        game: this.game,
        coords: this.coords,
        coordsFound: this.coordsFound,
        samples: this.edges.length,
      },
    });
  }
}
