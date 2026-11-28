import { describe, expect, test } from "bun:test";
import { isQueuedMutation } from "../mutation-queue.ts";

describe("isQueuedMutation", () => {
  test("accepts valid queued mutations with and without optional fields", () => {
    expect(
      isQueuedMutation({
        body: '{"ids":[1]}',
        method: "PATCH",
        trace: null,
        url: "/api/articles",
      }),
    ).toBe(true);
    expect(
      isQueuedMutation({
        account: 7,
        body: "{}",
        method: "DELETE",
        queuedAt: 1_700_000_000_000,
        trace: "trace-id",
        url: "/api/articles",
      }),
    ).toBe(true);
  });

  test("rejects malformed IndexedDB values", () => {
    expect(isQueuedMutation(null)).toBe(false);
    expect(isQueuedMutation("raw")).toBe(false);
    expect(isQueuedMutation({ body: "{}", method: "PATCH" })).toBe(false);
    expect(
      isQueuedMutation({
        body: "{}",
        method: "PATCH",
        trace: 123,
        url: "/api/articles",
      }),
    ).toBe(false);
    expect(
      isQueuedMutation({
        account: "7",
        body: "{}",
        method: "PATCH",
        trace: null,
        url: "/api/articles",
      }),
    ).toBe(false);
    expect(
      isQueuedMutation({
        body: "{}",
        method: "PATCH",
        queuedAt: Number.NaN,
        trace: null,
        url: "/api/articles",
      }),
    ).toBe(false);
  });
});
