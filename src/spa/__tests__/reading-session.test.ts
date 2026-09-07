import { describe, expect, test } from "bun:test";
import {
  capReaderScrolls,
  clearReaderScrolls,
  createThrottledRecorder,
  parseReadingSession,
  ratioToScrollTop,
  ReadingSessionStore,
  READING_SESSION_STORAGE_KEY,
  recordReaderScroll,
  scrollRatio,
  serializeReadingSession,
  type ReadingSession,
} from "../reading-session.ts";

const aSession = (overrides: Partial<ReadingSession> = {}): ReadingSession => ({
  app: {
    articleFilter: "unread",
    articleId: 11,
    listIds: [11, 12],
    listScrollTop: 240,
    nodeType: "source",
    nodeUid: "3",
  },
  reader: [{ at: 100, id: 11, ratio: 0.5 }],
  ...overrides,
});

describe("parse/serialize", () => {
  test("round-trips a snapshot", () => {
    const parsed = parseReadingSession(serializeReadingSession(aSession()));
    expect(parsed).toEqual(aSession());
    expect(serializeReadingSession(parsed!)).toBe(
      serializeReadingSession(aSession()),
    );
  });

  test("keeps the version out of the typed shape but in the blob", () => {
    const blob = JSON.parse(serializeReadingSession(aSession()));
    expect(blob.version).toBe(1);
  });

  test("drops a blob from a different version (the migration story)", () => {
    const raw = JSON.stringify({
      ...JSON.parse(serializeReadingSession(aSession())),
      version: 2,
    });
    expect(parseReadingSession(raw)).toBeUndefined();
  });

  test("drops garbage, truncation and wrong shapes silently", () => {
    expect(parseReadingSession(null)).toBeUndefined();
    expect(parseReadingSession("")).toBeUndefined();
    expect(parseReadingSession("not json {")).toBeUndefined();
    expect(parseReadingSession("42")).toBeUndefined();
    expect(parseReadingSession(JSON.stringify({ version: 1 }))).toBeUndefined();
  });

  test("drops entries with out-of-range ratios", () => {
    const raw = serializeReadingSession(
      aSession({ reader: [{ at: 1, id: 11, ratio: 1.5 }] }),
    );
    expect(parseReadingSession(raw)).toBeUndefined();
  });

  test("tolerates an absent app snapshot", () => {
    const raw = serializeReadingSession(aSession({ app: undefined }));
    expect(parseReadingSession(raw)?.app).toBeUndefined();
  });
});

describe("reader scroll LRU", () => {
  test("upserts and touches the written article", () => {
    const next = recordReaderScroll(aSession(), 11, 0.9, 200);
    expect(next.reader).toEqual([{ at: 200, id: 11, ratio: 0.9 }]);
  });

  test("caps to the newest entries", () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      at: index,
      id: index,
      ratio: 0.5,
    }));
    const capped = capReaderScrolls(many, 200);
    expect(capped.length).toBe(200);
    expect(capped[0]!.id).toBe(249);
    expect(capped.at(-1)!.id).toBe(50);
  });

  test("clearing drops the entries and the open-article pointer", () => {
    const next = recordReaderScroll(
      aSession({
        reader: [
          { at: 1, id: 11, ratio: 0.4 },
          { at: 2, id: 12, ratio: 0.6 },
        ],
      }),
      12,
      0.7,
      3,
    );
    const cleared = clearReaderScrolls(next, [12]);
    expect(cleared.reader.map((entry) => entry.id)).toEqual([11]);
    // The open article was 11, not 12: untouched.
    expect(cleared.app?.articleId).toBe(11);
    expect(clearReaderScrolls(next, [11]).app?.articleId).toBeUndefined();
    // Unrelated entries survive either clear.
    expect(
      clearReaderScrolls(next, [13]).reader.map((entry) => entry.id),
    ).toEqual([12, 11]);
  });
});

describe("scroll ratio helpers", () => {
  test("a short document reads as the top", () => {
    expect(
      scrollRatio({ clientHeight: 500, scrollHeight: 500, scrollTop: 0 }),
    ).toBe(0);
    expect(ratioToScrollTop(0.8, 500, 500)).toBe(0);
  });

  test("a ratio survives the round trip and clamps", () => {
    const element = { clientHeight: 400, scrollHeight: 2400, scrollTop: 800 };
    const ratio = scrollRatio(element);
    expect(ratio).toBeCloseTo(0.4);
    expect(ratioToScrollTop(ratio, 2400, 400)).toBe(800);
    expect(ratioToScrollTop(1.2, 2400, 400)).toBe(2000);
    expect(ratioToScrollTop(-1, 2400, 400)).toBe(0);
  });
});

describe("throttled recorder", () => {
  test("writes the first value immediately, then at most once per interval", () => {
    let time = 1000;
    const writes: number[] = [];
    const scheduled: Array<() => void> = [];
    const record = createThrottledRecorder(
      (value: number) => writes.push(value),
      {
        intervalMs: 500,
        now: () => time,
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
      },
    );
    record(1);
    expect(writes).toEqual([1]);
    // A burst inside the interval coalesces; nothing writes until the timer.
    record(2);
    record(3);
    expect(writes).toEqual([1]);
    time = 1500;
    scheduled.shift()!();
    expect(writes).toEqual([1, 3]);
    // The interval now dates from the trailing write.
    record(4);
    expect(writes).toEqual([1, 3]);
    time = 2000;
    scheduled.shift()!();
    expect(writes).toEqual([1, 3, 4]);
  });

  test("a burst coalesces into one trailing write with the latest value", () => {
    let time = 0;
    const writes: number[] = [];
    const scheduled: Array<() => void> = [];
    const record = createThrottledRecorder(
      (value: number) => writes.push(value),
      {
        intervalMs: 500,
        now: () => time,
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
      },
    );
    record(1);
    record(2);
    record(3);
    expect(writes).toEqual([1]);
    expect(scheduled.length).toBe(1);
    time = 400;
    scheduled[0]!();
    expect(writes).toEqual([1, 3]);
  });
});

class FakeStorage {
  #map = new Map<string, string>();
  getItem(key: string) {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.#map.set(key, value);
  }
  removeItem(key: string) {
    this.#map.delete(key);
  }
  dump() {
    return this.#map.get(READING_SESSION_STORAGE_KEY) ?? null;
  }
}

describe("ReadingSessionStore", () => {
  test("persists into both storages and prefers sessionStorage on load", () => {
    const local = new FakeStorage();
    const session = new FakeStorage();
    const store = new ReadingSessionStore({ local, session });
    store.recordApp({
      articleId: 11,
      listScrollTop: 120,
      nodeType: "source",
      nodeUid: "3",
    });
    expect(JSON.parse(local.dump()!).app.nodeUid).toBe("3");
    expect(session.dump()).toBe(local.dump());

    const fresher = serializeReadingSession({
      app: {
        articleFilter: "unread",
        articleId: 12,
        listIds: [],
        listScrollTop: 0,
        nodeType: "source",
        nodeUid: "9",
      },
      reader: [],
    });
    session.setItem(READING_SESSION_STORAGE_KEY, fresher);
    expect(
      new ReadingSessionStore({ local, session }).snapshot()?.nodeUid,
    ).toBe("9");
  });

  test("records and reads reader scroll ratios", () => {
    const store = new ReadingSessionStore({
      local: new FakeStorage(),
      now: () => 5,
      session: new FakeStorage(),
    });
    store.recordReaderScroll(11, 0.75);
    expect(store.readerScroll(11)).toBe(0.75);
    expect(store.readerScroll(12)).toBeUndefined();
  });

  test("a corrupt blob boots as no snapshot", () => {
    const local = new FakeStorage();
    local.setItem(READING_SESSION_STORAGE_KEY, "{{{");
    expect(
      new ReadingSessionStore({ local, session: new FakeStorage() }).snapshot(),
    ).toBeUndefined();
  });
});
