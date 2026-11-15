import { useEffect, useRef, useState } from "react";
import type { Coords } from "./ocr";
import { IDLE_STATE, LiveSession, type LiveState } from "./session";
import { DEFAULT_TRACKER_OPTIONS, type TrackerOptions } from "./tracker";

const OPTIONS_KEY = "archimap:live-options";

function loadOptions(): TrackerOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (saved && typeof saved.stableReads === "number") return { ...DEFAULT_TRACKER_OPTIONS, ...saved };
  } catch {
    // Blocked or corrupt storage: use the defaults.
  }
  return DEFAULT_TRACKER_OPTIONS;
}

export function useLiveCapture(zoneMaps: ReadonlySet<string>, onPosition: (coords: Coords) => void) {
  const [state, setState] = useState<LiveState>(IDLE_STATE);
  const [options, setOptions] = useState<TrackerOptions>(loadOptions);
  const onPositionRef = useRef(onPosition);
  const sessionRef = useRef<LiveSession | null>(null);
  sessionRef.current ??= new LiveSession(setState, (coords) => onPositionRef.current(coords));
  const session = sessionRef.current;

  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);
  useEffect(() => session.setZoneMaps(zoneMaps), [session, zoneMaps]);
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
