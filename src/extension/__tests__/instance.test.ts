import { describe, expect, test } from "bun:test";
import { pingInstance, type FetchLike } from "../instance.ts";

const okSession: FetchLike = (input) =>
  Promise.resolve(
    new Response(null, {
      status: input.toString().endsWith("/api/session") ? 200 : 404,
    }),
  );

describe("pingInstance", () => {
  test.each(["https://feeds.example.com/", "https://FEEDS.example.com:443"])(
    "fetches /api/session on the canonical origin of %s",
    async (instance) => {
      let requested = "";
      const ok = await pingInstance(instance, (input) => {
        requested = input.toString();
        return okSession(input);
      });
      expect(ok).toBe(true);
      expect(requested).toBe("https://feeds.example.com/api/session");
    },
  );

  test("reports a non-2xx response as unreachable", async () => {
    const ok = await pingInstance("https://feeds.example.com", () =>
      Promise.resolve(new Response(null, { status: 502 })),
    );
    expect(ok).toBe(false);
  });

  test("reports a network failure as unreachable", async () => {
    const ok = await pingInstance("https://feeds.example.com", () =>
      Promise.reject(new TypeError("network error")),
    );
    expect(ok).toBe(false);
  });

  test.each(["not a URL", "http://example.com", "ftp://example.com"])(
    "rejects %s without fetching",
    async (value) => {
      let called = false;
      const ok = await pingInstance(value, (input) => {
        called = true;
        return okSession(input);
      });
      expect(ok).toBe(false);
      expect(called).toBe(false);
    },
  );
});
