import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { markWebSubAvailability, type WebSubProbe } from "../feed-discovery.ts";
import { HttpClient } from "#platform/http/http-client.ts";
import { createFakeHttpRedis } from "#platform/http/__tests__/fake-http-redis.ts";

const feed = (title: string, url: string) => ({ title, url });

// The whole point of WebSubProbe being one method returning one field: a
// double is this, not a parsed feed.
const probe = (
  answer: (url: string) => { websub?: unknown } | never,
): WebSubProbe => ({
  parseUrl: async (url: string) => answer(url),
});

describe("markWebSubAvailability", () => {
  test("leaves a candidate unmarked when its parse has no hub", async () => {
    const result = await markWebSubAvailability(
      [
        feed("Undefined", "https://a.example/undefined"),
        feed("Absent", "https://a.example/absent"),
      ],
      probe((url) => (url.endsWith("undefined") ? { websub: undefined } : {})),
    );
    expect(result.map((candidate) => candidate.websub)).toEqual([false, false]);
  });

  // One bad candidate must not take the rest of the list with it, which is
  // what a bare Promise.all without the per-candidate catch would do.
  test("one failing candidate does not lose the others", async () => {
    const result = await markWebSubAvailability(
      [
        feed("Dead", "https://a.example/gone"),
        feed("Live", "https://a.example/push"),
      ],
      probe((url) => {
        if (url.includes("gone")) throw new Error("404");
        return { websub: { hubUrl: "https://hub.example/" } };
      }),
    );
    expect(result).toEqual([
      { title: "Dead", url: "https://a.example/gone", websub: false },
      { title: "Live", url: "https://a.example/push", websub: true },
    ]);
  });

  // #909: probed together, candidates on one host queue on its rate limit
  // and the ones whose turn misses the deadline read as having no hub.
  test("probes one candidate at a time and preserves order", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const result = await markWebSubAvailability(
      [
        feed("One", "https://a.example/one"),
        feed("Plain", "https://a.example/plain"),
        feed("Three", "https://a.example/three"),
      ],
      {
        parseUrl: async (url) => {
          inFlight++;
          mostInFlight = Math.max(mostInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
          return url.endsWith("plain") ? {} : { websub: {} };
        },
      },
    );
    expect(mostInFlight).toBe(1);
    expect(result).toEqual([
      { title: "One", url: "https://a.example/one", websub: true },
      { title: "Plain", url: "https://a.example/plain", websub: false },
      { title: "Three", url: "https://a.example/three", websub: true },
    ]);
  });

  // The same contract over a real client and host interval: each sequential
  // probe gets its slot inside its own deadline.
  test("every candidate on one host gets its true WebSub state", async () => {
    const client = new HttpClient(createFakeHttpRedis(), {
      deadlineMs: 2_000,
      intervalMs: { background: 10_000, interactive: 100 },
      transport: async (url) => {
        const body = Readable.from([url.endsWith("plain") ? "plain" : "hub"]);
        return {
          body,
          destroy: () => body.destroy(),
          headers: new Headers(),
          status: 200,
          url,
        };
      },
    });
    const result = await markWebSubAvailability(
      [
        feed("One", "https://1.1.1.1/one"),
        feed("Plain", "https://1.1.1.1/plain"),
        feed("Three", "https://1.1.1.1/three"),
      ],
      {
        parseUrl: async (url) => ({
          websub: (await client.get(url)).data === "hub" ? {} : undefined,
        }),
      },
    );
    expect(result.map((candidate) => candidate.websub)).toEqual([
      true,
      false,
      true,
    ]);
  });
});
