// Timers kept in a worker. When the browser window is hidden behind the game,
// Chrome slows the page's own timers down (to once a second, then once a
// minute after a few minutes), but not a dedicated worker's.

const SOURCE = "onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);";

export class Ticker {
  private worker: Worker | null = null;
  private waiting = new Map<number, () => void>();
  private nextId = 0;

  constructor() {
    try {
      this.worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" })));
      this.worker.onmessage = (e: MessageEvent<number>) => {
        const run = this.waiting.get(e.data);
        this.waiting.delete(e.data);
        run?.();
      };
    } catch {
      this.worker = null; // Page timers then.
    }
  }

  /** Runs `fn` after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void {
    if (!this.worker) {
      const timer = window.setTimeout(fn, ms);
      return () => clearTimeout(timer);
    }
    const id = this.nextId++;
    this.waiting.set(id, fn);
    this.worker.postMessage({ id, ms });
    return () => this.waiting.delete(id);
  }

  close() {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
  }
}
