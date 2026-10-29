import { afterEach, expect, test } from "bun:test";

// Bun has no localStorage; a Map stands in for whatever the browser holds.
const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
};
Object.assign(globalThis, { localStorage: storage });
// Before the import: the module-level preferences read storage on load.
stored.set("markReadOnOpen", "true");
const { markReadPolicy, storedPreference, storedToggle } =
  await import("../preferences.ts");
afterEach(() => {
  stored.clear();
  Object.assign(globalThis, { localStorage: storage });
});

test("the pre-#714 markReadOnOpen boolean becomes the on-open policy", () => {
  expect(markReadPolicy.get()).toBe("on-open");
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

test("reload picks up a value another tab wrote", () => {
  const toggle = storedToggle("sync", false);
  stored.set("sync", "true");
  expect(toggle.get()).toBe(false);
  toggle.reload();
  expect(toggle.get()).toBe(true);
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
