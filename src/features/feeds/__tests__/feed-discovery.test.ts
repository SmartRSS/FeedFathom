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
  test("marks a candidate that advertises a hub", async () => {
    const result = await markWebSubAvailability(
      [feed("Push", "https://a.example/feed")],
      probe(() => ({ websub: { hubUrl: "https://hub.example/" } })),
    );
    expect(result).toEqual([
      { title: "Push", url: "https://a.example/feed", websub: true },
    ]);
  });

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

  // A dead candidate is still worth showing: the failure surfaces when the
  // user previews it, and dropping it would make the page look like the feed
  // never existed.
  test("keeps a candidate whose parse throws, merely unmarked", async () => {
    const result = await markWebSubAvailability(
      [feed("Dead", "https://a.example/gone")],
      probe(() => {
        throw new Error("404");
      }),
    );
    expect(result).toEqual([
      { title: "Dead", url: "https://a.example/gone", websub: false },
    ]);
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

  // The list is rendered in the order the scanner found the feeds, so a slow
  // probe must not reorder it.
  test("preserves candidate order regardless of probe latency", async () => {
    const result = await markWebSubAvailability(
      [
        feed("Slow", "https://a.example/slow"),
        feed("Fast", "https://a.example/fast"),
      ],
      {
        parseUrl: async (url: string) => {
          if (url.includes("slow")) await Bun.sleep(20);
          return { websub: undefined };
        },
      },
    );
    expect(result.map((entry) => entry.title)).toEqual(["Slow", "Fast"]);
  });

  test("probes candidates concurrently rather than one after another", async () => {
    const started = Date.now();
    await markWebSubAvailability(
      [
        feed("A", "https://a.example/1"),
        feed("B", "https://a.example/2"),
        feed("C", "https://a.example/3"),
      ],
      {
        parseUrl: async () => {
          await Bun.sleep(30);
          return { websub: undefined };
        },
      },
    );
    expect(Date.now() - started).toBeLessThan(80);
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
