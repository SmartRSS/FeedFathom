import { describe, expect, test } from "bun:test";
import { markWebSubAvailability, type WebSubProbe } from "../feed-discovery.ts";

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

  test("probes concurrently and preserves order when probes finish in reverse", async () => {
    const slow = Promise.withResolvers<{ websub?: unknown }>();
    const fast = Promise.withResolvers<{ websub?: unknown }>();
    const started: string[] = [];
    const result = markWebSubAvailability(
      [
        feed("Slow", "https://a.example/slow"),
        feed("Fast", "https://a.example/fast"),
      ],
      {
        parseUrl: (url) => {
          started.push(url);
          return url.endsWith("slow") ? slow.promise : fast.promise;
        },
      },
    );
    try {
      expect(started).toEqual([
        "https://a.example/slow",
        "https://a.example/fast",
      ]);
      fast.resolve({});
      await fast.promise;
      slow.resolve({ websub: { hubUrl: "https://hub.example/" } });
      expect(await result).toEqual([
        { title: "Slow", url: "https://a.example/slow", websub: true },
        { title: "Fast", url: "https://a.example/fast", websub: false },
      ]);
    } finally {
      slow.resolve({});
      fast.resolve({});
      await result;
    }
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
