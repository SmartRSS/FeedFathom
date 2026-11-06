import { describe, expect, test } from "bun:test";
import {
  articlePageSize,
  type ArticleSummary,
} from "#shared/contracts/responses.ts";
import { ArticleList, emptyListState, type Cursor } from "../article-list.ts";

const row = (id: number): ArticleSummary => ({
  author: "",
  id,
  publishedAt: `2026-01-01T00:00:${String(id % 60).padStart(2, "0")}Z`,
  read: false,
  sourceId: 1,
  title: `Article ${id}`,
  url: `https://example.com/${id}`,
});
const page = (from: number, length: number) =>
  Array.from({ length }, (_, index) => row(from + index));

// Serves `total` rows a page at a time, after whichever id the cursor names.
function server(total: number) {
  const cursors: (number | undefined)[] = [];
  const request = async (
    _scope: unknown,
    cursor: Cursor | undefined,
  ): Promise<ArticleSummary[]> => {
    cursors.push(cursor?.id);
    const from = cursor ? cursor.id + 1 : 0;
    return page(from, Math.max(0, Math.min(articlePageSize, total - from)));
  };
  return { cursors, request };
}

describe("ArticleList", () => {
  test("pages on from the last row received", async () => {
    const { cursors, request } = server(articlePageSize + 3);
    const list = new ArticleList(request);
    await list.load({ sources: [1] });
    expect(list.rows()).toHaveLength(articlePageSize);
    expect(await list.loadMore()).toBe(3);
    expect(list.rows()).toHaveLength(articlePageSize + 3);
    expect(await list.loadMore()).toBeUndefined();
    expect(cursors).toEqual([undefined, articlePageSize - 1]);
  });

  test("a deleted page leaves the cursor where it was", async () => {
    const { cursors, request } = server(articlePageSize * 2);
    const list = new ArticleList(request);
    await list.load({ sources: [1] });
    list.setRows([]);
    await list.loadMore();
    expect(cursors.at(-1)).toBe(articlePageSize - 1);
    expect(list.rows()[0]?.id).toBe(articlePageSize);
  });

  test("a restore pages as far as it had loaded, at most five pages", async () => {
    const { request } = server(articlePageSize * 10);
    const list = new ArticleList(request);
    await list.load({ sources: [1] }, articlePageSize + 1);
    expect(list.rows()).toHaveLength(articlePageSize * 2);
    await list.load({ sources: [1] }, articlePageSize * 9);
    expect(list.rows()).toHaveLength(articlePageSize * 5);
  });

  test("a superseded list resolves to nothing and leaves the new one loading", async () => {
    let release: (() => void) | undefined;
    const list = new ArticleList(async (_scope, _cursor, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return page(0, 1);
    });
    const first = list.load({ sources: [1] });
    const firstRelease = release;
    const second = list.load({ sources: [2] });
    firstRelease?.();
    expect(await first).toBeUndefined();
    expect(list.loading()).toBe(true);
    release?.();
    expect(await second).toHaveLength(1);
    expect(list.loading()).toBe(false);
  });

  test("a failure that nothing superseded reaches the caller", async () => {
    const list = new ArticleList(async () => {
      throw new Error("offline");
    });
    expect(list.load({ sources: [1] })).rejects.toThrow("offline");
  });

  test("clearing stops paging", async () => {
    const { request } = server(articlePageSize * 2);
    const list = new ArticleList(request);
    await list.load({ sources: [1] });
    list.clear();
    expect(list.rows()).toEqual([]);
    expect(await list.loadMore()).toBeUndefined();
  });
});

describe("emptyListState", () => {
  const source = {
    favicon: null,
    homeUrl: "",
    kind: "feed" as const,
    name: "Feed",
    type: "source" as const,
    uid: "1",
    unreadCount: 0,
    xmlUrl: "",
  };
  const base = {
    feedsFailed: false,
    loading: false,
    rows: 0,
    searching: false,
    selected: undefined,
    signedIn: true,
  };

  test("says nothing over rows or while they load", () => {
    expect(emptyListState({ ...base, rows: 3 })).toBeUndefined();
    expect(emptyListState({ ...base, loading: true })).toBeUndefined();
  });

  test("an empty search is no match, whatever is selected", () => {
    expect(emptyListState({ ...base, searching: true, selected: source })).toBe(
      "noMatches",
    );
  });

  test("names why a selected node lists nothing", () => {
    expect(emptyListState({ ...base, selected: source })).toBe("caughtUp");
    expect(
      emptyListState({
        ...base,
        selected: { ...source, failing: { lastSuccess: null, reason: "x" } },
      }),
    ).toBe("failing");
    expect(
      emptyListState({
        ...base,
        selected: { children: [], name: "F", type: "folder", uid: "2" },
      }),
    ).toBe("emptyFolder");
  });

  test("with nothing selected, asks for a feed once the feeds are in", () => {
    expect(emptyListState(base)).toBe("pickFeed");
    expect(
      emptyListState({ ...base, feedsFailed: true, signedIn: false }),
    ).toBe("feedsFailed");
    expect(emptyListState({ ...base, signedIn: false })).toBeUndefined();
  });
});
