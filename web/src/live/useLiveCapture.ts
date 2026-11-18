import { useEffect, useRef, useState } from "react";
import type { Surroundings } from "./ocr";
import { IDLE_STATE, LiveSession, type LiveState } from "./session";
import { DEFAULT_TRACKER_OPTIONS, type TrackerOptions } from "./tracker";

const OPTIONS_KEY = "archimap:live-options";

export interface LiveOptions extends TrackerOptions {
  /** Switch to the zone the player walks into. */
  autoZone: boolean;
}

const DEFAULT_OPTIONS: LiveOptions = { ...DEFAULT_TRACKER_OPTIONS, autoZone: true };

function loadOptions(): LiveOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (saved && typeof saved.stableReads === "number") return { ...DEFAULT_OPTIONS, ...saved };
  } catch {
    // Blocked or corrupt storage: use the defaults.
  }
  return DEFAULT_OPTIONS;
}

/** @param around Maps of every zone and their passages, to settle readings. */
export function useLiveCapture(around: Surroundings) {
  const [state, setState] = useState<LiveState>(IDLE_STATE);
  const [options, setOptions] = useState<LiveOptions>(loadOptions);
  const sessionRef = useRef<LiveSession | null>(null);
  sessionRef.current ??= new LiveSession(setState);
  const session = sessionRef.current;

  useEffect(() => session.setSurroundings(around), [session, around]);
  useEffect(() => {
    session.setOptions(options);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // Not important if it can't be stored.
    }
  }, [session, options]);
  useEffect(() => () => session.stop(), [session]);

  return {
    state,
    options,
    setOptions,
    start: () => void session.start(),
    stop: () => session.stop(),
    pause: () => session.pause(),
    resume: () => session.resume(),
    recalibrate: () => session.recalibrate(),
  };
}

export type LiveCapture = ReturnType<typeof useLiveCapture>;
