import { expect, test } from "bun:test";
import { RedirectMap } from "#platform/http/redirect-map.ts";

test("reads redirect values concurrently and awaits every result", async () => {
  const keys = [
    "redirect_map:https://old.example/feed",
    "redirect_map:https://missing.example/feed",
  ];
  const redirect = Promise.withResolvers<string | null>();
  const missing = Promise.withResolvers<string | null>();
  const allStarted = Promise.withResolvers<void>();
  const values = new Map([
    [keys[0], redirect.promise],
    [keys[1], missing.promise],
  ]);
  const started: string[] = [];
  const redis = {
    async del() {
      return 1;
    },
    get(key: string) {
      started.push(key);
      if (started.length === keys.length) allStarted.resolve();
      return values.get(key) ?? Promise.resolve(null);
    },
    async keys() {
      return keys;
    },
    async set() {
      return "OK";
    },
  };
  const redirects = new RedirectMap(redis);

  const pending = redirects.getAllRedirects();
  await allStarted.promise;
  expect(started).toEqual(keys);

  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  redirect.resolve("https://new.example/feed");
  await Promise.resolve();
  expect(settled).toBe(false);

  missing.resolve(null);
  expect(await pending).toEqual({
    "https://old.example/feed": "https://new.example/feed",
  });
});
