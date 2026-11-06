import { afterAll, afterEach, expect, test } from "bun:test";

// Bun has no localStorage; a Map stands in for whatever the browser holds.
const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
};
// Bun has no window either; this one carries the storage events other tabs
// would send.
const window = new EventTarget();
Object.assign(globalThis, { localStorage: storage, window });
const { storedPreference } = await import("../preferences.ts");
const storedToggle = (key: string, fallback: boolean) =>
  storedPreference(key, [true, false], fallback);
afterEach(() => {
  stored.clear();
  Object.assign(globalThis, { localStorage: storage });
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
});

test("reads a stored value and falls back on anything else", () => {
  stored.set("step", "large");
  const steps = ["small", "medium", "large"] as const;
  expect(storedPreference("step", steps, "medium").get()).toBe("large");
  for (const value of ["narrow", "", "Large"]) {
    stored.set("step", value);
    expect(storedPreference("step", steps, "medium").get()).toBe("medium");
  }
  stored.delete("step");
  expect(storedPreference("step", steps, "medium").get()).toBe("medium");
});

test("set updates the signal and storage", () => {
  const preference = storedPreference("load", ["click", "open"], "click");
  preference.set("open");
  expect(preference.get()).toBe("open");
  expect(stored.get("load")).toBe("open");
});

test('toggles store booleans and still read the old "on"/"off" strings', () => {
  stored.set("a", "off");
  stored.set("b", "on");
  expect(storedToggle("a", true).get()).toBe(false);
  expect(storedToggle("b", false).get()).toBe(true);
  stored.set("a", "nonsense");
  expect(storedToggle("a", true).get()).toBe(true);

  const toggle = storedToggle("a", true);
  toggle.set(false);
  expect(stored.get("a")).toBe("false");
  expect(storedToggle("a", true).get()).toBe(false);
});

// What another tab's write looks like here: the storage changes, and a
// storage event names the key, or none when the storage was cleared.
const otherTabWrites = (key: string, value: string | undefined) => {
  if (value === undefined) stored.clear();
  else stored.set(key, value);
  window.dispatchEvent(
    Object.assign(new Event("storage"), {
      key: value === undefined ? null : key,
    }),
  );
};

test("follows a value another tab writes, or clears", () => {
  const toggle = storedToggle("sync", false);
  otherTabWrites("sync", "true");
  expect(toggle.get()).toBe(true);
  otherTabWrites("other", "false");
  expect(toggle.get()).toBe(true);
  otherTabWrites("sync", undefined);
  expect(toggle.get()).toBe(false);
});

test("storage that throws falls back without failing", () => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  });
  const toggle = storedToggle("blocked", true);
  expect(toggle.get()).toBe(true);
  toggle.set(false);
  expect(toggle.get()).toBe(false);
});
