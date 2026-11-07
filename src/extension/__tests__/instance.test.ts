import { describe, expect, test } from "bun:test";
import { pingInstance } from "../instance.ts";
import { canonicalizeInstance } from "../url-helpers.ts";

const instance = canonicalizeInstance("https://feeds.example.com");
if (!instance) throw new Error("test instance must be canonical");

describe("pingInstance", () => {
  test("fetches /api/session on the instance", async () => {
    let requested = "";
    const ok = await pingInstance(instance, async (input) => {
      requested = input instanceof Request ? input.url : input.toString();
      return new Response(null, { status: 200 });
    });
    expect(ok).toBe(true);
    expect(requested).toBe("https://feeds.example.com/api/session");
  });

  test("reports a non-2xx response as unreachable", async () => {
    const ok = await pingInstance(instance, () =>
      Promise.resolve(new Response(null, { status: 502 })),
    );
    expect(ok).toBe(false);
  });

  test("reports a network failure as unreachable", async () => {
    const ok = await pingInstance(instance, () =>
      Promise.reject(new TypeError("network error")),
    );
    expect(ok).toBe(false);
  });
});
