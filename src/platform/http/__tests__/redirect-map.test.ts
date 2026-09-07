import { expect, test } from "bun:test";
import { RedirectMap } from "#platform/http/redirect-map.ts";

const prefix = "redirect_map:";

// KEYS walks the whole keyspace in one command and blocks the server, and this
// Redis also carries the job queue and the HTTP cache -- so the admin
// redirects page used to stall every feed fetch behind it.
test("walks the keyspace in SCAN pages and reads each page in one MGET", async () => {
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
  const mgetCalls: string[][] = [];
  const scanCursors: string[] = [];
  const redis = {
    async del() {
      return 1;
    },
    async get() {
      return null;
    },
    async mget(...keys: string[]) {
      mgetCalls.push(keys);
      return keys.map((key) => stored.get(key) ?? null);
    },
    async scan(cursor: string, _match: "MATCH", pattern: string) {
      scanCursors.push(cursor);
      expect(pattern).toBe(`${prefix}*`);
      return pages[cursor]!;
    },
    async set() {
      return "OK";
    },
  };

  const redirects = await new RedirectMap(redis).getAllRedirects();

  // Both pages, and the iteration stopped at the zero cursor rather than
  // returning only what the first page happened to hold.
  expect(scanCursors).toEqual(["0", "17"]);
  expect(mgetCalls).toHaveLength(2);
  expect(redirects).toEqual({
    "https://a.example/feed": "https://new-a.example/feed",
    "https://b.example/feed": "https://new-b.example/feed",
  });
});

// A cursor iteration is allowed to hand the same key back twice.
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
