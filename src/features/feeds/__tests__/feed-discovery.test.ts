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
  test("leaves a candidate without a hub unmarked", async () => {
    const result = await markWebSubAvailability(
      [feed("Plain", "https://a.example/feed")],
      probe(() => ({ websub: undefined })),
    );
    expect(result[0]?.websub).toBe(false);
  });

  test("treats a parse with no websub field at all as unmarked", async () => {
    const result = await markWebSubAvailability(
      [feed("Plain", "https://a.example/feed")],
      probe(() => ({})),
    );
    expect(result[0]?.websub).toBe(false);
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

  test("probes one candidate at a time and preserves order", async () => {
    const slow = Promise.withResolvers<{ websub?: unknown }>();
    const started: string[] = [];
    const result = markWebSubAvailability(
      [
        feed("Slow", "https://a.example/slow"),
        feed("Fast", "https://a.example/fast"),
      ],
      {
        parseUrl: async (url) => {
          started.push(url);
          return url.endsWith("slow") ? slow.promise : {};
        },
      },
    );
    try {
      await Bun.sleep(10);
      expect(started).toEqual(["https://a.example/slow"]);
      slow.resolve({ websub: { hubUrl: "https://hub.example/" } });
      expect(await result).toEqual([
        { title: "Slow", url: "https://a.example/slow", websub: true },
        { title: "Fast", url: "https://a.example/fast", websub: false },
      ]);
    } finally {
      slow.resolve({});
      await result;
    }
  });

  // Probed together, candidates on one host raced for its rate limit, and
  // the losers came back marked as having no hub.
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

  test("an empty candidate list yields an empty result", async () => {
    expect(
      await markWebSubAvailability(
        [],
        probe(() => ({})),
      ),
    ).toEqual([]);
  });
});
