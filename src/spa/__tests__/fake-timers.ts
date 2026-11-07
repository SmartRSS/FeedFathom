// A manual clock: advance() runs every timer that falls due, in order.
export function fakeTimers() {
  let time = 0;
  let nextId = 0;
  const pending = new Map<unknown, { at: number; run: () => void }>();
  return {
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...pending].toSorted(([, a], [, b]) => a.at - b.at)[0];
        if (!due || due[1].at > end) break;
        pending.delete(due[0]);
        time = due[1].at;
        due[1].run();
      }
      time = end;
    },
    clear: (handle: unknown) => void pending.delete(handle),
    now: () => time,
    pendingDelays: () => [...pending.values()].map((timer) => timer.at - time),
    set(run: () => void, ms: number) {
      nextId += 1;
      pending.set(nextId, { at: time + ms, run });
      return nextId;
    },
  };
}
