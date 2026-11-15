import { describe, expect, test } from "bun:test";
import { createLocalProgressStore, type KeyValueStorage } from "./progressStore";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("localStorage progress store", () => {
  test("set, get and persist per zone", () => {
    const storage = memoryStorage();
    const store = createLocalProgressStore(storage);
    store.set("a", "1,2", true);
    store.set("a", "-3,4", true);
    store.set("b", "0,0", true);
    expect([...store.get("a")]).toEqual(["1,2", "-3,4"]);
    expect(JSON.parse(storage.data.get("archimap:progress:a")!)).toEqual(["1,2", "-3,4"]);
    expect(createLocalProgressStore(storage).get("b").has("0,0")).toBe(true);
  });

  test("snapshot identity is stable until a change", () => {
    const store = createLocalProgressStore(memoryStorage());
    const first = store.get("a");
    expect(store.get("a")).toBe(first);
    store.set("a", "1,1", false); // no-op
    expect(store.get("a")).toBe(first);
    store.set("a", "1,1", true);
    expect(store.get("a")).not.toBe(first);
  });

  test("uncheck and reset", () => {
    const storage = memoryStorage();
    const store = createLocalProgressStore(storage);
    store.set("a", "1,1", true);
    store.set("a", "2,2", true);
    store.set("a", "1,1", false);
    expect([...store.get("a")]).toEqual(["2,2"]);
    store.reset("a");
    expect(store.get("a").size).toBe(0);
    expect(storage.data.has("archimap:progress:a")).toBe(false);
  });

  test("subscribers are notified for their zone only", () => {
    const store = createLocalProgressStore(memoryStorage());
    let a = 0;
    let b = 0;
    const unsubscribe = store.subscribe("a", () => a++);
    store.subscribe("b", () => b++);
    store.set("a", "1,1", true);
    store.reset("a");
    store.reset("a"); // already empty: no notification
    expect([a, b]).toEqual([2, 0]);
    unsubscribe();
    store.set("a", "1,1", true);
    expect(a).toBe(2);
  });

  test("survives corrupt data and missing storage", () => {
    const store = createLocalProgressStore(memoryStorage({ "archimap:progress:a": "{oops" }));
    expect(store.get("a").size).toBe(0);
    const memoryOnly = createLocalProgressStore(undefined);
    memoryOnly.set("a", "1,1", true);
    expect(memoryOnly.get("a").has("1,1")).toBe(true);
  });
});
