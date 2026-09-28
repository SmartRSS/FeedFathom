import { afterEach, expect, test } from "bun:test";
import {
  navigatorConnection,
  prefetchNextEnabled,
  setPrefetchNext,
  shouldPrefetch,
} from "../reading-prefetch.ts";

afterEach(() => setPrefetchNext("off"));

test("the preference defaults to off and follows the last set value", () => {
  expect(prefetchNextEnabled()).toBe("off");
  setPrefetchNext("on");
  expect(prefetchNextEnabled()).toBe("on");
  setPrefetchNext("off");
  expect(prefetchNextEnabled()).toBe("off");
});

test("Save Data suppresses the prefetch; absent connection does not", () => {
  expect(shouldPrefetch({ saveData: true })).toBe(false);
  expect(shouldPrefetch({ saveData: false })).toBe(true);
  expect(shouldPrefetch(undefined)).toBe(true);
});

test("navigatorConnection reads the real connection object when present", () => {
  const withConnection = { connection: { saveData: true } };
  // Partial mock: the function only reads `connection`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  expect(navigatorConnection(withConnection as unknown as Navigator)).toEqual({
    saveData: true,
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  expect(navigatorConnection({} as Navigator)).toBeUndefined();
});
