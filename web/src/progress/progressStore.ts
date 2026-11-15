// Checked-map progress, per zone. Everything goes through ProgressStore so a
// shared backend (phase 4) can replace localStorage without touching the UI.

export type CheckedSet = ReadonlySet<string>;

export interface ProgressStore {
  /** Checked map keys ("x,y") for a zone. Same object until it changes. */
  get(zone: string): CheckedSet;
  set(zone: string, key: string, checked: boolean): void;
  reset(zone: string): void;
  /** Called on any change to the zone, including from other tabs. */
  subscribe(zone: string, listener: () => void): () => void;
}

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "archimap:progress:";
const EMPTY: CheckedSet = new Set();

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // Blocked storage (private mode, sandboxed iframe).
  }
}

export function createLocalProgressStore(
  storage: KeyValueStorage | undefined = defaultStorage(),
): ProgressStore {
  const cache = new Map<string, CheckedSet>();
  const listeners = new Map<string, Set<() => void>>();

  function load(zone: string): CheckedSet {
    try {
      const raw = storage?.getItem(PREFIX + zone);
      const keys: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(keys)) return new Set(keys.filter((k) => typeof k === "string"));
    } catch {
      // Unreadable or corrupt entry: start empty.
    }
    return EMPTY;
  }

  function save(zone: string, checked: CheckedSet) {
    try {
      if (checked.size === 0) storage?.removeItem(PREFIX + zone);
      else storage?.setItem(PREFIX + zone, JSON.stringify([...checked]));
    } catch {
      // Quota or blocked storage: keep the in-memory state.
    }
  }

  function notify(zone: string) {
    listeners.get(zone)?.forEach((listener) => listener());
  }

  function update(zone: string, checked: CheckedSet) {
    cache.set(zone, checked);
    save(zone, checked);
    notify(zone);
  }

  const store: ProgressStore = {
    get(zone) {
      let checked = cache.get(zone);
      if (!checked) {
        checked = load(zone);
        cache.set(zone, checked);
      }
      return checked;
    },
    set(zone, key, checked) {
      const current = store.get(zone);
      if (current.has(key) === checked) return;
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      update(zone, next);
    },
    reset(zone) {
      if (store.get(zone).size > 0) update(zone, EMPTY);
    },
    subscribe(zone, listener) {
      let set = listeners.get(zone);
      if (!set) listeners.set(zone, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key === null) {
        cache.clear();
        listeners.forEach((_, zone) => notify(zone));
      } else if (event.key.startsWith(PREFIX)) {
        const zone = event.key.slice(PREFIX.length);
        cache.delete(zone);
        notify(zone);
      }
    });
  }

  return store;
}
