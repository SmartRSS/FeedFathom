// The clock and timers a controller runs on, injected so its tests advance
// time by hand instead of sleeping.
export type Timers = {
  clear(handle: unknown): void;
  now(): number;
  set(callback: () => void, ms: number): unknown;
};

export const browserTimers: Timers = {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every handle comes from set() below
  clear: (handle) => clearTimeout(handle as number | undefined),
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
};
