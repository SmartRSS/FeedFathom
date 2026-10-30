import { describe, expect, test } from "bun:test";
import {
  createEmailWorker,
  type IncomingEmailMessage,
} from "#features/mail-ingest/email-worker.ts";

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
  setReject() {
    throw new Error("Message was rejected");
  },
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
      raw: Buffer.from(raw).toString("base64"),
      to: "newsletter@example.com",
    });
  });

  // Base64 rather than text is the whole point: an 8-bit body in a legacy
  // charset used to come back as U+FFFD once it round-tripped through UTF-8.
  test("relays raw MIME bytes that are not valid UTF-8", async () => {
    const bytes = Uint8Array.from([0x53, 0x3a, 0x20, 0xe9, 0x0d, 0x0a, 0xff]);
    let body: string | undefined;
    const worker = createEmailWorker(async (_input, init) => {
      body = typeof init?.body === "string" ? init.body : undefined;
      return new Response(null, { status: 204 });
    });

    await worker.email(
      message({ raw: bytes, rawSize: bytes.byteLength }),
      environment(),
    );

    if (body === undefined) throw new Error("Relay request body was not JSON");
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null || !("raw" in payload))
      throw new Error("Relay payload had no raw field");
    expect(Buffer.from(String(payload.raw), "base64").equals(bytes)).toBe(true);
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
    ).rejects.toThrow(
      "MAIL_ENDPOINT_DOMAIN must be https, or http on loopback",
    );
    await expect(
      worker.email(
        message(),
        environment({ MAIL_ENDPOINT_DOMAIN: "http://[::1]:3456" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      worker.email(
        message(),
        environment({ MAIL_ENDPOINT_DOMAIN: "https://reader.example/path" }),
      ),
    ).rejects.toThrow("MAIL_ENDPOINT_DOMAIN must contain only a URL origin");

    expect(endpoints).toEqual([
      "http://localhost:3456/api/mail",
      "http://[::1]:3456/api/mail",
    ]);
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

  // The size is the sender's fault, so this is the one bounce the worker
  // decides without asking /api/mail.
  test("rejects an oversized message by declared and encoded size, before relaying", async () => {
    let fetchCalls = 0;
    let rawReads = 0;
    const errors: string[] = [];
    const reasons: string[] = [];
    const worker = createEmailWorker(async () => {
      fetchCalls++;
      return new Response(null, { status: 204 });
    }, logger(errors));
    const setReject = (reason: string) => {
      reasons.push(reason);
    };
    const oversizedMessage: IncomingEmailMessage = {
      from: "sender@example.com",
      get raw() {
        rawReads++;
        return raw;
      },
      rawSize: maxRawEmailBytes + 1,
      setReject,
      to: "newsletter@example.com",
    };

    await worker.email(oversizedMessage, environment());
    expect(rawReads).toBe(0);

    await worker.email(
      message({
        raw: "é".repeat(maxRawEmailBytes / 2 + 1),
        rawSize: maxRawEmailBytes,
        setReject,
      }),
      environment(),
    );

    await worker.email(
      message({ raw: "a".repeat(maxRawEmailBytes), rawSize: maxRawEmailBytes }),
      environment(),
    );

    expect(reasons).toEqual(["Message exceeds 5 MiB", "Message exceeds 5 MiB"]);
    expect(fetchCalls).toBe(1);
    expect(errors).toEqual([]);
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

  test("rejects with the server's reason on a 422 that says rejected, without logging", async () => {
    const errors: string[] = [];
    const reasons: string[] = [];
    const worker = createEmailWorker(
      async () =>
        Response.json(
          { error: "No recipients known", rejected: true },
          { status: 422 },
        ),
      logger(errors),
    );

    await worker.email(
      message({ setReject: (value) => reasons.push(value) }),
      environment(),
    );

    expect(reasons).toEqual(["No recipients known"]);
    expect(errors).toEqual([]);
  });

  // A bounce can end a subscription, so anything short of the explicit
  // signal is a temporary failure: a reverse proxy's HTML 413, a schema 422
  // from Worker/server version skew, or the right flag on the wrong status.
  test.each([
    [413, new Response("<html>413 Request Entity Too Large</html>")],
    [413, Response.json({ error: "Raw email exceeds 5 MiB" })],
    [422, Response.json({ error: "Expected string" })],
    [422, new Response("<html>proxy page</html>")],
    [422, Response.json({ error: "x", rejected: "true" })],
    [500, Response.json({ error: "x", rejected: true })],
    [401, Response.json({ error: "x" })],
    [404, Response.json({ error: "x" })],
    [503, Response.json({ error: "x" })],
  ])(
    "throws and logs the status, rather than rejecting, on %p without the rejection signal",
    async (status, body) => {
      const errors: string[] = [];
      const reasons: string[] = [];
      const worker = createEmailWorker(
        async () => new Response(body.body, { status }),
        logger(errors),
      );

      await expect(
        worker.email(
          message({ setReject: (value) => reasons.push(value) }),
          environment(),
        ),
      ).rejects.toThrow(`Mail relay failed with status ${status}`);
      expect(reasons).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`status ${status}`);
    },
  );

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
