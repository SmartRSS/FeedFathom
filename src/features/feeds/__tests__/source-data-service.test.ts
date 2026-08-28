import { describe, expect, test } from "bun:test";
import {
  parseSourceListRows,
  resolveSourceListOrder,
} from "#features/feeds/source-data-service.ts";

const sourceRow = {
  createdAt: new Date("2026-07-22T10:00:00.000Z"),
  homeUrl: "https://example.com",
  id: 1,
  lastAttempt: new Date("2026-07-22T10:05:00.000Z"),
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  subscriberCount: 3,
  url: "https://example.com/feed.xml",
  websubStatus: "none" as const,
};

describe("source raw projections", () => {
  test("accepts Bun SQL Date values and numeric COUNT values", () => {
    expect(parseSourceListRows([sourceRow])).toEqual([sourceRow]);
  });

  test("rejects string COUNT and date representations", () => {
    expect(() =>
      parseSourceListRows([{ ...sourceRow, subscriberCount: "3" }]),
    ).toThrow("Database returned invalid source list rows");
    expect(() =>
      parseSourceListRows([
        { ...sourceRow, createdAt: "2026-07-22T10:00:00.000Z" },
      ]),
    ).toThrow("Database returned invalid source list rows");
  });

  test("rejects malformed or expanded raw rows", () => {
    expect(() => parseSourceListRows([{ ...sourceRow, id: 1.5 }])).toThrow(
      "Database returned invalid source list rows",
    );
    expect(() =>
      parseSourceListRows([{ ...sourceRow, unexpected: true }]),
    ).toThrow("Database returned invalid source list rows");
  });
});

describe("source list SQL policy", () => {
  test("maps supported literals to fixed SQL fragments", () => {
    expect(resolveSourceListOrder("createdAt", "asc")).toEqual({
      order: "ASC",
      sort: "s.created_at",
    });
    expect(resolveSourceListOrder("recentFailures", "desc")).toEqual({
      order: "DESC",
      sort: "s.recent_failures",
    });
    expect(resolveSourceListOrder("lastAttempt", "asc")).toEqual({
      order: "ASC",
      sort: "s.last_attempt",
    });
    expect(resolveSourceListOrder("lastSuccess", "desc")).toEqual({
      order: "DESC",
      sort: "s.last_success",
    });
    expect(resolveSourceListOrder("subscriberCount", "desc")).toEqual({
      order: "DESC",
      sort: '"subscriberCount"',
    });
    expect(resolveSourceListOrder("url", "asc")).toEqual({
      order: "ASC",
      sort: "s.url",
    });
  });

  test("falls back for unsupported and injected values", () => {
    expect(
      resolveSourceListOrder('url"; DROP TABLE sources; --', "sideways"),
    ).toEqual({ order: "ASC", sort: "s.created_at" });
  });
});
