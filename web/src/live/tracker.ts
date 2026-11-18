import { coordsKey, isAdjacent, type Coords } from "./ocr";

export interface TrackerOptions {
  /** Identical readings in a row needed to confirm a move to a neighbouring map. */
  stableReads: number;
  /** Needed for a jump to a non-adjacent map (teleport, misread, first position is exempt). */
  jumpReads: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = { stableReads: 3, jumpReads: 6 };

/** Turns a stream of per-capture readings into confirmed positions. */
export class PositionTracker {
  current: Coords | null = null;
  private candidate: Coords | null = null;
  private count = 0;
  /** A map change was seen: the next confirmed reading is an arrival, even on the same coordinates (stairs). */
  private moving = false;

  constructor(private options: TrackerOptions = DEFAULT_TRACKER_OPTIONS) {}

  setOptions(options: TrackerOptions) {
    this.options = options;
  }

  /** Feed one reading (null = unreadable). Returns the position if it just got confirmed. */
  push(reading: Coords | null): Coords | null {
    if (!reading) return null; // Unreadable frames neither confirm nor break a streak.
    if (!this.moving && this.current && coordsKey(reading) === coordsKey(this.current)) {
      this.candidate = null;
      this.count = 0;
      return null;
    }
    if (this.candidate && coordsKey(reading) === coordsKey(this.candidate)) this.count++;
    else {
      this.candidate = reading;
      this.count = 1;
    }
    const same = this.current !== null && coordsKey(reading) === coordsKey(this.current);
    const needed =
      this.current === null || same || isAdjacent(reading, this.current) ? this.options.stableReads : this.options.jumpReads;
    if (this.count < needed) return null;
    this.current = reading;
    this.candidate = null;
    this.count = 0;
    this.moving = false;
    return reading;
  }

  /** The player changed maps (a loading screen was seen): the next confirmed reading is where they arrived. */
  moved() {
    this.moving = true;
    this.candidate = null;
    this.count = 0;
  }

  reset() {
    this.current = this.candidate = null;
    this.count = 0;
    this.moving = false;
  }
}
