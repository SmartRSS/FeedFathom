import { describe, expect, test } from "bun:test";
import {
  createEmailWorker,
  type IncomingEmailMessage,
} from "../src/cloudflare/email-worker.ts";

const mailRelaySecretHeader = "x-feedfathom-mail-secret";
const maxRawEmailBytes = 5 * 1_024 * 1_024;
const raw = "Subject: Newsletter\r\n\r\nArticle body";

const environment = (
  overrides: Partial<{
    MAIL_ENDPOINT_DOMAIN: string;
    MAIL_RELAY_SECRET: string;
  }> = {},
) => ({
  MAIL_ENDPOINT_DOMAIN: "https://reader.example",
  MAIL_RELAY_SECRET: "relay-secret",
  ...overrides,
});

const message = (
  overrides: Partial<IncomingEmailMessage> = {},
): IncomingEmailMessage => ({
  from: "sender@example.com",
  raw,
  rawSize: new TextEncoder().encode(raw).byteLength,
  to: "newsletter@example.com",
  ...overrides,
});

const requestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const logger = (errors: string[]) => ({
  error(value: string) {
    errors.push(value);
  },
});

describe("Cloudflare email worker", () => {
  test("relays a validated message to the HTTPS mail endpoint", async () => {
    let captured:
      | { init: RequestInit | undefined; input: RequestInfo | URL }
      | undefined;
    const worker = createEmailWorker(async (input, init) => {
      captured = { init, input };
      return new Response(null, { status: 204 });
    });

    await worker.email(message(), environment());

    if (!captured) throw new Error("Relay request was not sent");
    expect(requestUrl(captured.input)).toBe("https://reader.example/api/mail");
    expect(captured.init?.method).toBe("POST");
    expect(new Headers(captured.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(captured.init?.headers).get(mailRelaySecretHeader)).toBe(
      "relay-secret",
    );
    if (typeof captured.init?.body !== "string")
      throw new Error("Relay request body was not JSON");
    const payload: unknown = JSON.parse(captured.init.body);
    expect(payload).toEqual({
      from: "sender@example.com",
      raw,
      to: "newsletter@example.com",
    });
  });

  test("allows HTTP only for loopback endpoint origins", async () => {
    const endpoints: string[] = [];
    const errors: string[] = [];
    const worker = createEmailWorker(async (input) => {
      endpoints.push(requestUrl(input));
      return new Response(null, { status: 200 });
    }, logger(errors));

    await worker.email(
      message(),
      environment({ MAIL_ENDPOINT_DOMAIN: "http://localhost:3456" }),
    );
    await expect(
      worker.email(
        message(),
        environment({ MAIL_ENDPOINT_DOMAIN: "http://reader.example" }),
      ),
    ).rejects.toThrow("Invalid Cloudflare email worker environment");
    await expect(
      worker.email(
        message(),
        environment({ MAIL_ENDPOINT_DOMAIN: "https://reader.example/path" }),
      ),
    ).rejects.toThrow("MAIL_ENDPOINT_DOMAIN must contain only a URL origin");

    expect(endpoints).toEqual(["http://localhost:3456/api/mail"]);
    expect(errors).toHaveLength(2);
  });

  test("rejects malformed environments and incoming projections before fetch", async () => {
    let fetchCalls = 0;
    const errors: string[] = [];
    const worker = createEmailWorker(async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    }, logger(errors));

    await expect(worker.email(message(), {})).rejects.toThrow(
      "Invalid Cloudflare email worker environment",
    );
    await expect(
      worker.email(message({ from: 42 }), environment()),
    ).rejects.toThrow("Invalid incoming email message");

    expect(fetchCalls).toBe(0);
    expect(errors).toHaveLength(2);
  });

  test("checks declared and encoded raw sizes before relaying", async () => {
    let fetchCalls = 0;
    let rawReads = 0;
    const errors: string[] = [];
    const worker = createEmailWorker(async () => {
      fetchCalls++;
      return new Response(null, { status: 204 });
    }, logger(errors));
    const oversizedMessage: IncomingEmailMessage = {
      from: "sender@example.com",
      get raw() {
        rawReads++;
        return raw;
      },
      rawSize: maxRawEmailBytes + 1,
      to: "newsletter@example.com",
    };

    await expect(worker.email(oversizedMessage, environment())).rejects.toThrow(
      "Raw email exceeds 5 MiB",
    );
    expect(rawReads).toBe(0);

    await expect(
      worker.email(
        message({
          raw: "é".repeat(maxRawEmailBytes / 2 + 1),
          rawSize: maxRawEmailBytes,
        }),
        environment(),
      ),
    ).rejects.toThrow("Raw email exceeds 5 MiB");

    await worker.email(
      message({ raw: "a".repeat(maxRawEmailBytes), rawSize: maxRawEmailBytes }),
      environment(),
    );

    expect(fetchCalls).toBe(1);
    expect(errors).toHaveLength(2);
  });

  test("throws and logs bounded diagnostics for non-success responses", async () => {
    const errors: string[] = [];
    const worker = createEmailWorker(
      async () => new Response("x".repeat(10_000), { status: 503 }),
      logger(errors),
    );

    const error = await worker
      .email(message(), environment())
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected relay error");
    expect(error.message).toStartWith("Mail relay failed with status 503:");
    expect(error.message.length).toBeLessThan(1_100);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.length).toBeLessThan(1_250);
  });

  test("logs and propagates network failures", async () => {
    const failure = new Error("network unavailable");
    const errors: string[] = [];
    const worker = createEmailWorker(async () => {
      throw failure;
    }, logger(errors));

    await expect(worker.email(message(), environment())).rejects.toBe(failure);
    expect(errors).toEqual([
      "Cloudflare email relay failed: network unavailable",
    ]);
  });
});
