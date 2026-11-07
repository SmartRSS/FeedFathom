import { describe, expect, test } from "bun:test";
import type { AppSnapshot } from "../reading-session.ts";
import { ReadingSessionStore } from "../reading-session.ts";
import { restoredSelection, SessionRestore } from "../session-restore.ts";

const snapshot = (patch: Partial<AppSnapshot>): AppSnapshot => ({
  articleFilter: "unread",
  articleId: undefined,
  listScrollTop: 0,
  nodeType: "source",
  nodeUid: "1",
  ...patch,
});
const rows = [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }];

describe("restoredSelection", () => {
  test("reselects the rows the snapshot named, by id", () => {
    expect(
      restoredSelection(
        rows,
        snapshot({ anchorId: 13, focusedId: 12, selectedIds: [12, 11] }),
      ),
    ).toEqual({ anchor: 3, focus: 2, indexes: [2, 1] });
  });

  test("an older snapshot restores its open article alone", () => {
    expect(restoredSelection(rows, snapshot({ articleId: 12 }))).toEqual({
      anchor: 2,
      focus: 2,
      indexes: [2],
    });
  });

  test("anchor and focus fall back to the first restored row", () => {
    expect(
      restoredSelection(
        rows,
        snapshot({ anchorId: 99, focusedId: 98, selectedIds: [13, 11] }),
      ),
    ).toEqual({ anchor: 1, focus: 1, indexes: [3, 1] });
  });

  test("a stale snapshot whose rows are gone restores nothing", () => {
    expect(
      restoredSelection(rows, snapshot({ articleId: 99, selectedIds: [98] })),
    ).toBeUndefined();
    expect(restoredSelection(rows, snapshot({}))).toBeUndefined();
  });
});

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};

const restore = () =>
  new SessionRestore(
    new ReadingSessionStore({
      local: memoryStorage(),
      remember: () => true,
      session: memoryStorage(),
    }),
  );

describe("SessionRestore", () => {
  test("records nothing while a restore is in progress", () => {
    const session = restore();
    session.begin();
    session.record({ nodeUid: "2" });
    expect(session.store.takeSnapshot()).toBeUndefined();
    session.finish();
    session.record({ nodeUid: "2" });
    expect(session.store.takeSnapshot()?.nodeUid).toBe("2");
  });

  test("the observer pass after a restore only takes note, once", () => {
    const session = restore();
    session.begin();
    session.finish();
    expect(session.takePassiveFirstPass()).toBe(true);
    expect(session.takePassiveFirstPass()).toBe(false);
  });

  test("a feed picked mid-restore makes the next pass a real one", () => {
    const session = restore();
    session.begin();
    session.cancel();
    expect(session.restoring()).toBe(false);
    expect(session.takePassiveFirstPass()).toBe(false);
  });

  test("the reader position applies only to the article the restore opened", () => {
    const session = restore();
    session.store.recordReaderScroll(11, 0.4);
    session.resumeReaderAt(11);
    expect(session.takeReaderScroll(11)).toBe(0.4);
    expect(session.takeReaderScroll(11)).toBeUndefined();
    session.resumeReaderAt(11);
    expect(session.takeReaderScroll(12)).toBeUndefined();
    expect(session.takeReaderScroll(11)).toBeUndefined();
  });
});
