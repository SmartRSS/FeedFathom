import { describe, expect, test } from "bun:test";
import {
  readerCapabilitiesRequest,
  readerFetchRequest,
  readerMaximumHtmlBytes,
  type ReaderErrorCode,
} from "#shared/reader-bridge.ts";
import { handleReaderRequest, type Fetch } from "../reader-fetch.ts";
import { canonicalizeInstance } from "../url-helpers.ts";

const canonical = (value: string) => {
  const origin = canonicalizeInstance(value);
  if (!origin) throw new Error(`${value} must be a canonical instance`);
  return origin;
};
const instance = canonical("https://reader.example");
const sender = { frameId: 0, url: `${instance}/` };
const request = readerFetchRequest;
const capabilityRequest = readerCapabilitiesRequest;

const unsafeUrls: [string, ReaderErrorCode][] = [
  ["file:///etc/passwd", "INVALID_URL"],
  ["https://user:password@example.com/story", "INVALID_URL"],
  ["http://localhost/story", "PRIVATE_URL"],
  ["http://localhost./story", "PRIVATE_URL"],
  ["http://x.localhost./story", "PRIVATE_URL"],
  ["http://127.0.0.1/story", "PRIVATE_URL"],
  ["http://2130706433/story", "PRIVATE_URL"],
  ["http://0x7f000001/story", "PRIVATE_URL"],
  ["http://10.1.2.3/story", "PRIVATE_URL"],
  ["http://169.254.1.2/story", "PRIVATE_URL"],
  ["http://192.168.1.2/story", "PRIVATE_URL"],
  ["http://[::1]/story", "PRIVATE_URL"],
  ["http://[fd00::1]/story", "PRIVATE_URL"],
];

describe("handleReaderRequest", () => {
  test("advertises capability only to the configured top-frame origin", async () => {
    const allowed = await handleReaderRequest(
      capabilityRequest(),
      sender,
      instance,
    );
    expect(allowed.ok).toBe(true);

    await Promise.all(
      (
        [
          [{ frameId: 1, url: `${instance}/` }, instance, "UNAUTHORIZED"],
          [
            { frameId: 0, url: "https://other.example/" },
            instance,
            "UNAUTHORIZED",
          ],
          [sender, null, "UNAVAILABLE"],
        ] as const
      ).map(async ([messageSender, configuredInstance, error]) => {
        const response = await handleReaderRequest(
          capabilityRequest(),
          messageSender,
          configuredInstance,
        );
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error).toBe(error);
      }),
    );
  });

  test("rejects missing, malformed, and extra sender projection data", async () => {
    await Promise.all(
      [
        {},
        { frameId: 0 },
        { url: `${instance}/` },
        { frameId: "0", url: `${instance}/` },
        { extra: true, frameId: 0, url: `${instance}/` },
      ].map(async (messageSender) => {
        const response = await handleReaderRequest(
          capabilityRequest(),
          messageSender,
          instance,
        );
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error).toBe("UNAUTHORIZED");
      }),
    );
  });

  test("permits exact loopback HTTP development instances", async () => {
    const response = await handleReaderRequest(
      capabilityRequest(),
      { frameId: 0, url: "http://localhost:3456/dashboard" },
      canonical("http://localhost:3456"),
    );
    expect(response.ok).toBe(true);
  });

  test.each(unsafeUrls)("rejects unsafe article URL %s", async (url, error) => {
    let fetchCalls = 0;
    const fetchImplementation: Fetch = async () => {
      fetchCalls++;
      return new Response();
    };
    const response = await handleReaderRequest(
      request(url),
      sender,
      instance,
      fetchImplementation,
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toBe(error);
    expect(fetchCalls).toBe(0);
  });

  test("fetches credential-free HTML and returns the validated final URL", async () => {
    let capturedOptions: RequestInit | undefined;
    const fetchImplementation: Fetch = async (_input, options) => {
      capturedOptions = options;
      return new Response("<article>Story</article>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };
    const response = await handleReaderRequest(
      request("https://article.example/story"),
      sender,
      instance,
      fetchImplementation,
    );

    expect(response).toMatchObject({
      finalUrl: "https://article.example/story",
      html: "<article>Story</article>",
      ok: true,
    });
    expect(capturedOptions?.credentials).toBe("omit");
    expect(capturedOptions?.redirect).toBe("manual");
    expect(capturedOptions?.referrer).toBe("");
  });

  test("rejects an opaque redirect with a stable error", async () => {
    const opaqueRedirect = new Response();
    Object.defineProperties(opaqueRedirect, {
      ok: { value: false },
      status: { value: 0 },
      type: { value: "opaqueredirect" },
    });

    const response = await handleReaderRequest(
      request("https://article.example/start"),
      sender,
      instance,
      async () => opaqueRedirect,
    );

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toBe("INVALID_RESPONSE");
  });

  test("rejects non-HTML and oversized responses", async () => {
    const nonHtml = await handleReaderRequest(
      request("https://article.example/data"),
      sender,
      instance,
      async () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    expect(nonHtml.ok).toBe(false);
    if (!nonHtml.ok) expect(nonHtml.error).toBe("NOT_HTML");

    const oversized = await handleReaderRequest(
      request("https://article.example/large"),
      sender,
      instance,
      async () =>
        new Response("", {
          headers: {
            "content-length": String(readerMaximumHtmlBytes + 1),
            "content-type": "text/html",
          },
        }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toBe("TOO_LARGE");
  });
});

// The detector itself is tested in decode-body.test.ts; this checks the
// reader hands it the body and the header.
test("decodes the page in its declared charset", async () => {
  const privet = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // "Привет" in windows-1251
  const response = await handleReaderRequest(
    request("https://article.example/story"),
    sender,
    instance,
    async () =>
      new Response(Uint8Array.from(privet), {
        headers: { "content-type": "text/html; charset=windows-1251" },
      }),
  );
  expect(response).toMatchObject({ html: "Привет", ok: true });
});
