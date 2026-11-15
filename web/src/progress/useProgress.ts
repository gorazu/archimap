import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { createLocalProgressStore, type ProgressStore } from "./progressStore";

export const ProgressStoreContext = createContext<ProgressStore>(createLocalProgressStore());

export function useProgress(zone: string) {
  const store = useContext(ProgressStoreContext);
  const subscribe = useCallback((listener: () => void) => store.subscribe(zone, listener), [store, zone]);
  const getSnapshot = useCallback(() => store.get(zone), [store, zone]);
  const checked = useSyncExternalStore(subscribe, getSnapshot);

  const toggle = useCallback(
    (key: string) => store.set(zone, key, !store.get(zone).has(key)),
    [store, zone],
  );
  const check = useCallback((key: string) => store.set(zone, key, true), [store, zone]);
  const reset = useCallback(() => store.reset(zone), [store, zone]);

  return { checked, toggle, check, reset };
}
