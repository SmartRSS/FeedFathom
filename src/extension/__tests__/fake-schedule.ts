import type { Schedule } from "../menu-sync.ts";

// A clock the test advances by hand, so debounces are exact rather than
// raced against real time.
export const fakeSchedule = () => {
  let now = 0;
  let timers: { at: number; callback: () => void }[] = [];
  const schedule: Schedule = (callback, delayMs) => {
    const timer = { at: now + delayMs, callback };
    timers.push(timer);
    return () => {
      timers = timers.filter((pending) => pending !== timer);
    };
  };
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now);
    timers = timers.filter((timer) => timer.at > now);
    for (const timer of due.toSorted((a, b) => a.at - b.at)) timer.callback();
  };
  return { advance, schedule };
};
