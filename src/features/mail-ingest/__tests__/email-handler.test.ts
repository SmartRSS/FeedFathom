import { expect, test } from "bun:test";
import { simpleParser, type ParsedMail } from "mailparser";
import type { Source } from "#platform/db/schemas/sources.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import { ArticleImporter } from "#features/feeds/article-import.ts";
import {
  EmailHandler,
  MailRejectedError,
} from "#features/mail-ingest/email-handler.ts";

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
  reservedBy: null,
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
  const published: [number, number][] = [];
  const handler = new EmailHandler(
    {
      async findSourceByUrl(address) {
        lookups.push(address);
        return address === source.url ? source : undefined;
      },
      async successSource() {},
    },
    new ArticleImporter(
      {
        async batchUpsertArticles(articles) {
          batches.push(articles);
          return articles.length;
        },
      },
      {
        async recomputeUnreadCounts() {},
      },
      {
        publish(sourceId, count) {
          published.push([sourceId, count]);
        },
      },
    ),
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
  ).rejects.toThrow(new MailRejectedError("No recipients known"));

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
  expect(published).toEqual([[source.id, 1]]);
});

type Batch = Parameters<ArticlesDataService["batchUpsertArticles"]>[0];

// A handler over the real importer, recording each stored batch.
function recordingHandler(parse?: (raw: Buffer) => Promise<ParsedMail>) {
  const batches: Batch[] = [];
  const handler = new EmailHandler(
    { findSourceByUrl: async () => source, async successSource() {} },
    new ArticleImporter(
      {
        async batchUpsertArticles(articles) {
          batches.push(articles);
          return articles.length;
        },
      },
      { async recomputeUnreadCounts() {} },
      { publish() {} },
    ),
    parse,
  );
  const deliver = (lines: string[]) =>
    handler.processEmail(Buffer.from(lines.join("\r\n")), {
      from: "sender@example.com",
      to: source.url,
    });
  return { batches, deliver };
}

test.each([
  ["text/html", "<p>HTML body</p>", "<p>HTML body</p>"],
  ["text/plain", "Plain body", "<p>Plain body</p>"],
])("stores a %s body as the article content", async (type, body, content) => {
  const { batches, deliver } = recordingHandler();

  await deliver([
    "Subject: Body",
    `Content-Type: ${type}; charset=utf-8`,
    "",
    body,
  ]);

  expect(batches[0]?.[0]?.content).toBe(content);
});

test("a message with no body or subject is still stored, as placeholders", async () => {
  const { batches, deliver } = recordingHandler();

  await deliver(["From: sender@example.com", "", ""]);

  expect(batches[0]?.[0]).toMatchObject({
    content: "No content.",
    title: "Untitled",
  });
});

// The guid is the dedupe key: a relay that delivers the same message twice,
// re-encoded, must not make two articles, and two different messages without
// a Message-ID must not collapse into one.
test("dedupes by Message-ID, and by the raw bytes when there is none", async () => {
  const { batches, deliver } = recordingHandler();
  const guids = () => batches.map((batch) => batch[0]?.guid);

  await deliver(["Message-ID: <One@Example.com>", "Subject: A", "", "x"]);
  await deliver(["Message-ID: one@example.com ", "Subject: A again", "", "y"]);
  await deliver(["Subject: B", "", "x"]);
  await deliver(["Subject: C", "", "x"]);
  await deliver(["Subject: C", "", "x"]);

  const [first, again, plainB, plainC, plainCAgain] = guids();
  expect(again).toBe(first);
  expect(plainB).not.toBe(plainC);
  expect(plainCAgain).toBe(plainC);
  expect(new Set(guids()).size).toBe(3);
});

test("refuses a parse result that breaks the fields it reads", async () => {
  const { batches, deliver } = recordingHandler(async (raw) => {
    const parsed = await simpleParser(raw);
    Reflect.set(parsed, "html", undefined);
    return parsed;
  });

  const error = await deliver(["Subject: Broken", "", "x"]).catch(
    (cause: unknown) => cause,
  );
  expect(error).toEqual(
    new Error("Mail parser returned an invalid message projection"),
  );
  expect(error).not.toBeInstanceOf(MailRejectedError);
  expect(batches).toEqual([]);
});
