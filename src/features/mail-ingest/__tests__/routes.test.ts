import {
  mailRelaySecretHeader,
  maxRawEmailBytes,
} from "#shared/contracts/mail-relay.ts";
import { MailRejectedError } from "#features/mail-ingest/email-handler.ts";
import { expect, test } from "bun:test";
import {
  createDependencies,
  appFor,
  type App,
  post,
} from "../../../__tests__/server-harness.ts";

const relayed = (raw: string) => Buffer.from(raw).toString("base64");

const relayMail = (app: App, envelope: Record<string, unknown>) =>
  post(app, "/api/mail", envelope, {
    headers: { [mailRelaySecretHeader]: "relay-secret" },
  });

test("fails closed when mail ingestion or relay authentication is unavailable", async () => {
  const cases = [
    { enabled: false, expectedStatus: 404, requestSecret: "relay-secret" },
    { enabled: true, expectedStatus: 401, requestSecret: "relay-secret" },
    {
      configuredSecret: "relay-secret",
      enabled: true,
      expectedStatus: 401,
    },
    {
      configuredSecret: "relay-secret",
      enabled: true,
      expectedStatus: 401,
      requestSecret: "wrong-secret-with-different-length",
    },
  ];

  /* eslint-disable no-await-in-loop -- Module mocks are shared within this test file. */
  for (const testCase of cases) {
    const dependencies = createDependencies();
    dependencies.config.MAIL_ENABLED = testCase.enabled;
    if (testCase.configuredSecret) {
      dependencies.config.MAIL_RELAY_SECRET = testCase.configuredSecret;
    }
    let handlerCalls = 0;
    dependencies.emailHandler.processEmail = async () => {
      handlerCalls++;
    };
    const app = await appFor(dependencies);
    const response = await post(
      app,
      "/api/mail",
      {
        from: "sender@example.com",
        raw: relayed("Subject: Test\r\n\r\nBody"),
        to: "reader@example.com",
      },
      {
        headers: testCase.requestSecret
          ? { [mailRelaySecretHeader]: testCase.requestSecret }
          : {},
      },
    );

    expect(response.status).toBe(testCase.expectedStatus);
    expect(handlerCalls).toBe(0);
  }
  /* eslint-enable no-await-in-loop */
});

test("authenticates incoming mail and passes the normalized trusted envelope", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const processed: Array<{
    envelope: { from: string; to: string };
    raw: string;
  }> = [];
  dependencies.emailHandler.processEmail = async (raw, envelope) => {
    if (!Buffer.isBuffer(raw)) throw new Error("Expected buffered mail input");
    processed.push({ envelope, raw: raw.toString("utf8") });
  };
  const app = await appFor(dependencies);

  const response = await relayMail(app, {
    from: "  sender@example.com  ",
    raw: relayed("Subject: Test\r\n\r\nBody"),
    to: " Reader@Example.com ",
  });

  expect(response.status).toBe(200);
  expect(processed).toEqual([
    {
      envelope: {
        from: "sender@example.com",
        to: "reader@example.com",
      },
      raw: "Subject: Test\r\n\r\nBody",
    },
  ]);
});

test("enforces the raw MIME byte limit before EmailHandler", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const sizes: number[] = [];
  dependencies.emailHandler.processEmail = async (raw) => {
    if (!Buffer.isBuffer(raw)) throw new Error("Expected buffered mail input");
    sizes.push(raw.byteLength);
  };
  const app = await appFor(dependencies);
  const mail = (raw: string) =>
    relayMail(app, {
      from: "sender@example.com",
      raw,
      to: "reader@example.com",
    });

  const exact = await mail(relayed("a".repeat(maxRawEmailBytes)));
  const over = await mail(relayed("a".repeat(maxRawEmailBytes + 1)));
  const notBase64 = await mail("Subject: Test\r\n\r\nBody");

  expect(exact.status).toBe(200);
  expect(over.status).not.toBe(200);
  expect(notBase64.status).toBe(422);
  expect(sizes).toEqual([maxRawEmailBytes]);
});

test.each([
  [
    "an unknown recipient",
    new MailRejectedError("No recipients known"),
    422,
    { error: "No recipients known", rejected: true },
  ],
  [
    "a storage failure",
    new Error("connection terminated"),
    500,
    { error: "Internal Server Error" },
  ],
])(
  "answers %s with its status, so the relay bounces only the sender's faults",
  async (_kind, failure, status, body) => {
    const dependencies = createDependencies();
    dependencies.config.MAIL_ENABLED = true;
    dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
    dependencies.emailHandler.processEmail = async () => {
      throw failure;
    };
    const app = await appFor(dependencies);

    const response = await relayMail(app, {
      from: "sender@example.com",
      raw: relayed("Subject: Test\r\n\r\nBody"),
      to: "unknown@example.com",
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  },
);

// A schema failure here mostly means Worker/server version skew mid-deploy, so
// it must not carry the flag the relay bounces on.
test("answers a malformed relay body with 422 but no rejection signal", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const app = await appFor(dependencies);

  const response = await relayMail(app, { from: "sender@example.com" });

  expect(response.status).toBe(422);
  expect(await response.json()).not.toHaveProperty("rejected");
});

// The relay carries base64 precisely so that an 8-bit body in a legacy
// charset arrives byte for byte; routing it as UTF-8 text replaced every
// such byte with U+FFFD.
test("delivers raw MIME bytes that are not valid UTF-8", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  const latin1 = Buffer.from(
    "Subject: caf\u00e9\r\n\r\nR\u00e9sum\u00e9",
    "latin1",
  );
  const received: Buffer[] = [];
  dependencies.emailHandler.processEmail = async (raw) => {
    if (!Buffer.isBuffer(raw)) throw new Error("Expected buffered mail input");
    received.push(raw);
  };
  const app = await appFor(dependencies);

  const response = await relayMail(app, {
    from: "sender@example.com",
    raw: latin1.toString("base64"),
    to: "reader@example.com",
  });

  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]?.equals(latin1)).toBe(true);
});

test("rejects malformed mail envelopes before EmailHandler", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAIL_ENABLED = true;
  dependencies.config.MAIL_RELAY_SECRET = "relay-secret";
  let handlerCalls = 0;
  dependencies.emailHandler.processEmail = async () => {
    handlerCalls++;
  };
  const app = await appFor(dependencies);

  const response = await relayMail(app, {
    from: "sender@example.com",
    raw: "Subject: Test\r\n\r\nBody",
  });

  expect(response.status).toBe(422);
  expect(handlerCalls).toBe(0);
});
