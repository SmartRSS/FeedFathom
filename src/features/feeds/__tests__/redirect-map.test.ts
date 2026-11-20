import { expect, test } from "bun:test";
import { RedirectMap } from "#features/feeds/redirect-map.ts";

const prefix = "redirect_map:";

test("reads every redirect across all SCAN pages", async () => {
  const pages: Record<string, [string, string[]]> = {
    "0": ["17", [`${prefix}https://a.example/feed`]],
    "17": [
      "0",
      [`${prefix}https://b.example/feed`, `${prefix}https://gone.example/feed`],
    ],
  };
  const stored = new Map([
    [`${prefix}https://a.example/feed`, "https://new-a.example/feed"],
    [`${prefix}https://b.example/feed`, "https://new-b.example/feed"],
  ]);
  const redis = {
    async del() {
      return 1;
    },
    async get() {
      return null;
    },
    async mget(...keys: string[]) {
      return keys.map((key) => stored.get(key) ?? null);
    },
    async scan(cursor: string, _match: "MATCH", pattern: string) {
      expect(pattern).toBe(`${prefix}*`);
      return pages[cursor]!;
    },
    async set() {
      return "OK";
    },
  };

  const redirects = await new RedirectMap(redis).getAllRedirects();

  expect(redirects).toEqual({
    "https://a.example/feed": "https://new-a.example/feed",
    "https://b.example/feed": "https://new-b.example/feed",
  });
});

test("tolerates a key returned by more than one page", async () => {
  const key = `${prefix}https://a.example/feed`;
  const pages: Record<string, [string, string[]]> = {
    "0": ["9", [key]],
    "9": ["0", [key]],
  };
  const redis = {
    async del() {
      return 1;
    },
    async get() {
      return null;
    },
    async mget(...keys: string[]) {
      return keys.map(() => "https://new.example/feed");
    },
    async scan(cursor: string) {
      return pages[cursor]!;
    },
    async set() {
      return "OK";
    },
  };

  expect(await new RedirectMap(redis).getAllRedirects()).toEqual({
    "https://a.example/feed": "https://new.example/feed",
  });
});
