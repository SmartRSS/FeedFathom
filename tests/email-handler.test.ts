import { expect, test } from "bun:test";
import type { Source } from "#platform/db/schemas/sources.ts";
import type { ArticlesDataService } from "#features/reader/article-data-service.ts";
import { EmailHandler } from "../src/lib/email/email-handler.ts";

const source: Source = {
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  favicon: null,
  homeUrl: "https://reader.example/",
  id: 42,
  kind: "email",
  lastAttempt: null,
  lastFetchTrigger: null,
  lastSuccess: null,
  recentFailureDetails: "",
  recentFailures: 0,
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  url: "trusted-recipient@example.com",
  websubCallbackToken: null,
  websubHubUrl: null,
  websubLeaseExpiresAt: null,
  websubSecret: null,
  websubStatus: "none",
  websubSubscribeAttemptedAt: null,
  websubTopicUrl: null,
};

test("routes by the trusted envelope and rejects unknown envelope recipients", async () => {
  const lookups: string[] = [];
  const batches: Parameters<ArticlesDataService["batchUpsertArticles"]>[0][] =
    [];
  const handler = new EmailHandler(
    {
      async findSourceByUrl(address) {
        lookups.push(address);
        return address === source.url ? source : undefined;
      },
      async successSource() {},
    },
    {
      async batchUpsertArticles(articles) {
        batches.push(articles);
      },
    },
    {
      async recomputeUnreadCounts() {},
    },
  );
  const raw = Buffer.from(
    [
      "From: forged-sender@example.com",
      "To: forged-recipient@example.com",
      "Subject: Trusted routing",
      "Date: Mon, 20 Jul 2026 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Parsed body",
    ].join("\r\n"),
  );

  await handler.processEmail(raw, {
    from: "trusted-sender@example.com",
    to: source.url,
  });
  await expect(
    handler.processEmail(raw, {
      from: "trusted-sender@example.com",
      to: "unknown-recipient@example.com",
    }),
  ).rejects.toThrow("No recipients known");

  expect(lookups).toEqual([
    "trusted-recipient@example.com",
    "unknown-recipient@example.com",
  ]);
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(1);
  expect(batches[0]?.[0]).toMatchObject({
    author: "trusted-sender@example.com",
    content: "<p>Parsed body</p>",
    publishedAt: new Date("2026-07-20T12:00:00.000Z"),
    sourceId: source.id,
    title: "Trusted routing",
  });
});
