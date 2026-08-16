import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config.ts";
import { MailSender } from "../src/lib/email/mail-sender.ts";

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ALLOWED_EMAILS: [],
  ARTICLE_STALE_AFTER_DAYS: 365,
  CLEANUP_INTERVAL: 1_000,
  DATABASE_URL: "postgresql://localhost/feedfathom_test",
  DB_POOL_MAX: 10,
  ENABLE_REGISTRATION: false,
  GATHER_JOBS_INTERVAL: 1_000,
  LOCK_DURATION: 1_000,
  MAIL_ENABLED: false,
  USER_DORMANT_AFTER_DAYS: 365,
  USER_EXPIRY_DAYS: 730,
  WORKER_CONCURRENCY: 1,
  ...overrides,
});

describe("MailSender", () => {
  test("posts the Mailjet payload with Basic auth and a local activation link", async () => {
    let captured:
      | { init: RequestInit | undefined; input: RequestInfo | URL }
      | undefined;
    const sender = new MailSender(
      config({
        FEED_FATHOM_DOMAIN: "localhost:3456",
        MAILJET_API_KEY: "mailjet-key",
        MAILJET_API_SECRET: "mailjet-secret",
      }),
      async (input, init) => {
        captured = { init, input };
        return new Response(null, { status: 200 });
      },
    );

    await sender.sendActivationEmail("reader@example.com", "activation-token");

    if (!captured) throw new Error("Mailjet request was not sent");
    expect(captured.input).toBe("https://api.mailjet.com/v3.1/send");
    expect(captured.init?.method).toBe("POST");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${btoa("mailjet-key:mailjet-secret")}`,
    );
    expect(headers.get("content-type")).toBe("application/json");
    if (typeof captured.init?.body !== "string")
      throw new Error("Mailjet request body was not JSON");
    const payload: unknown = JSON.parse(captured.init.body);
    expect(payload).toEqual({
      Messages: [
        {
          From: {
            Email: "welcome@localhost:3456",
            Name: "FeedFathom",
          },
          HTMLPart:
            '<p>Please activate your account by clicking this link: <a href="http://localhost:3456/activate/activation-token">http://localhost:3456/activate/activation-token</a></p>',
          Subject: "Activate your FeedFathom account",
          TextPart:
            "Please activate your account by clicking this link: http://localhost:3456/activate/activation-token",
          To: [{ Email: "reader@example.com" }],
        },
      ],
    });
  });

  test("does nothing when Mailjet credentials are absent", async () => {
    let calls = 0;
    const sender = new MailSender(config(), async () => {
      calls++;
      return new Response(null, { status: 200 });
    });

    await expect(
      sender.sendActivationEmail("reader@example.com", "activation-token"),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  test("resolves for successful Mailjet responses", async () => {
    const sender = new MailSender(
      config({
        MAILJET_API_KEY: "mailjet-key",
        MAILJET_API_SECRET: "mailjet-secret",
      }),
      async () => new Response("accepted", { status: 202 }),
    );

    await expect(
      sender.sendActivationEmail("reader@example.com", "activation-token"),
    ).resolves.toBeUndefined();
  });

  test("throws a bounded diagnostic for non-success responses", async () => {
    const sender = new MailSender(
      config({
        MAILJET_API_KEY: "mailjet-key",
        MAILJET_API_SECRET: "mailjet-secret",
      }),
      async () => new Response("x".repeat(10_000), { status: 429 }),
    );

    const error = await sender
      .sendActivationEmail("reader@example.com", "activation-token")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected Mailjet error");
    expect(error.message).toStartWith(
      "Mailjet request failed with status 429:",
    );
    expect(error.message.length).toBeLessThan(1_100);
  });

  test("propagates network failures", async () => {
    const failure = new Error("network unavailable");
    const sender = new MailSender(
      config({
        MAILJET_API_KEY: "mailjet-key",
        MAILJET_API_SECRET: "mailjet-secret",
      }),
      async () => {
        throw failure;
      },
    );

    await expect(
      sender.sendActivationEmail("reader@example.com", "activation-token"),
    ).rejects.toBe(failure);
  });
});
