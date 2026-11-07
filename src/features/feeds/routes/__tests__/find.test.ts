import { expect, test } from "bun:test";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { OutboundFetchBudget } from "#features/feeds/outbound-fetch-budget.ts";
import { getFindHandler } from "#features/feeds/routes/find.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";

const page = "https://site.example/";

const find = async (body: Uint8Array<ArrayBuffer>, contentType: string) => {
  const probed: string[] = [];
  const response = await getFindHandler(
    { query: { link: page }, user: { id: 1 } },
    {
      feedParser: strictFake<FeedParser>({
        parseUrl: async (url) => {
          probed.push(url);
          throw new Error("not a feed");
        },
      }),
      httpClient: {
        get: async (url) => ({
          data: body.buffer,
          headers: new Headers({ "content-type": contentType }),
          url,
        }),
      },
      outboundFetchBudget: strictFake<OutboundFetchBudget>({
        consume: async () => {},
      }),
    },
  );
  return { found: await response.json(), probed };
};

// "Новости" in windows-1251, as a Russian site serves it.
const novosti = [0xcd, 0xee, 0xe2, 0xee, 0xf1, 0xf2, 0xe8];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

test("reads feed titles in the page's own charset", async () => {
  const html = Uint8Array.from([
    ...ascii(
      '<html><head><link type="application/rss+xml" href="/rss" title="',
    ),
    ...novosti,
    ...ascii('"></head></html>'),
  ]);

  const { found } = await find(html, "text/html; charset=windows-1251");

  expect(found).toEqual([
    { title: "Новости", url: "https://site.example/rss", websub: false },
  ]);
});

// Probing the suggestion would send the page address to openrss.org before
// the user chose to try it.
test("suggests OpenRSS for a page with no feeds without contacting it", async () => {
  const { found, probed } = await find(
    Uint8Array.from(ascii("<html><body>nothing here</body></html>")),
    "text/html",
  );

  expect(found).toEqual([
    {
      title: "Attempt to use OpenRSS",
      url: "https://openrss.org/site.example/",
      websub: false,
    },
  ]);
  expect(probed).toEqual([]);
});
