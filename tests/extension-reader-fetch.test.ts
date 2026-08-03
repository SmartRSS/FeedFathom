import { describe, expect, test } from "bun:test";
import {
  isListFeedsMessage,
  isReaderRequest,
  isReaderResponse,
  isReaderResponseForRequest,
  isVisibilityLostMessage,
  readerBridgeChannel,
  readerBridgeVersion,
  storedInstance,
  type ReaderErrorCode,
  type ReaderRequest,
} from "../src/extension/extension-types.ts";
import {
  handleReaderRequest,
  type ReaderFetch,
} from "../src/extension/reader-fetch.ts";

const instance = "https://reader.example";
const sender = { frameId: 0, url: `${instance}/` };
const request = (url: string): Extract<ReaderRequest, { action: "fetch" }> => ({
  action: "fetch",
  channel: readerBridgeChannel,
  id: crypto.randomUUID(),
  type: "request",
  url,
  version: readerBridgeVersion,
});
const capabilityRequest = (): ReaderRequest => ({
  action: "capabilities",
  channel: readerBridgeChannel,
  id: crypto.randomUUID(),
  type: "request",
  version: readerBridgeVersion,
});

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

describe("Reader bridge protocol", () => {
  test("accepts only exact extension message shapes", () => {
    expect(
      isListFeedsMessage({
        action: "list-feeds",
        feedsData: [{ title: "Example", url: "https://example.com/feed" }],
      }),
    ).toBe(true);
    expect(
      isListFeedsMessage({
        action: "list-feeds",
        extra: true,
        feedsData: [{ title: "Example", url: "https://example.com/feed" }],
      }),
    ).toBe(false);
    expect(
      isListFeedsMessage({
        action: "list-feeds",
        feedsData: [
          { extra: true, title: "Example", url: "https://example.com/feed" },
        ],
      }),
    ).toBe(false);
    expect(isListFeedsMessage({ action: "list-feeds" })).toBe(false);
    expect(
      isListFeedsMessage({
        action: "list-feeds",
        feedsData: [{ url: "https://example.com/feed" }],
      }),
    ).toBe(false);
    expect(isVisibilityLostMessage({ action: "visibility-lost" })).toBe(true);
    expect(
      isVisibilityLostMessage({ action: "visibility-lost", extra: true }),
    ).toBe(false);
  });

  test("accepts only exact storage result shapes", () => {
    expect(storedInstance({ instance: "https://reader.example" })).toBe(
      "https://reader.example",
    );
    expect(storedInstance({})).toBeUndefined();
    for (const value of [
      null,
      { instance: 1 },
      { extra: true },
      { extra: true, instance: "https://reader.example" },
    ])
      expect(storedInstance(value)).toBeUndefined();
  });

  test("accepts only exact correlated reader message shapes", () => {
    const validRequest = request("https://article.example/story");
    expect(isReaderRequest(validRequest)).toBe(true);
    expect(isReaderRequest({ ...validRequest, extra: true })).toBe(false);
    expect(isReaderRequest({ ...validRequest, id: "not-a-uuid" })).toBe(false);

    const response = {
      action: "fetch",
      channel: readerBridgeChannel,
      finalUrl: validRequest.url,
      html: "<article>Story</article>",
      id: validRequest.id,
      ok: true,
      type: "response",
      version: readerBridgeVersion,
    };
    expect(isReaderResponse(response)).toBe(true);
    expect(isReaderResponse({ ...response, extra: true })).toBe(false);
    expect(isReaderResponseForRequest(response, validRequest)).toBe(true);
    expect(
      isReaderResponseForRequest(
        { ...response, id: crypto.randomUUID() },
        validRequest,
      ),
    ).toBe(false);
    expect(
      isReaderResponseForRequest(
        { ...response, action: "capabilities", available: true },
        validRequest,
      ),
    ).toBe(false);
  });

  test("accepts every Reader error variant and rejects unknown variants", () => {
    const validRequest = request("https://article.example/story");
    const errorCodes: ReaderErrorCode[] = [
      "FETCH_FAILED",
      "INVALID_RESPONSE",
      "INVALID_URL",
      "NOT_HTML",
      "PRIVATE_URL",
      "TIMEOUT",
      "TOO_LARGE",
      "TOO_MANY_REDIRECTS",
      "UNAUTHORIZED",
      "UNAVAILABLE",
    ];

    for (const error of errorCodes) {
      expect(
        isReaderResponse({
          action: validRequest.action,
          channel: readerBridgeChannel,
          error,
          id: validRequest.id,
          ok: false,
          type: "response",
          version: readerBridgeVersion,
        }),
      ).toBe(true);
    }

    expect(
      isReaderResponse({
        action: validRequest.action,
        channel: readerBridgeChannel,
        error: "UNKNOWN",
        id: validRequest.id,
        ok: false,
        type: "response",
        version: readerBridgeVersion,
      }),
    ).toBe(false);
  });
});

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
          [sender, "http://reader.example", "UNAVAILABLE"],
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
      "http://localhost:3456",
    );
    expect(response.ok).toBe(true);
  });

  test.each(unsafeUrls)("rejects unsafe article URL %s", async (url, error) => {
    let fetchCalls = 0;
    const fetchImplementation: ReaderFetch = async () => {
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
    const fetchImplementation: ReaderFetch = async (_input, options) => {
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

  test("follows an injected visible public redirect", async () => {
    let fetchCalls = 0;
    const response = await handleReaderRequest(
      request("https://article.example/start"),
      sender,
      instance,
      async () => {
        fetchCalls++;
        return fetchCalls === 1
          ? new Response(null, {
              headers: { location: "https://cdn.example/story" },
              status: 302,
            })
          : new Response("<article>Redirected story</article>", {
              headers: { "content-type": "text/html" },
            });
      },
    );

    expect(response).toMatchObject({
      finalUrl: "https://cdn.example/story",
      html: "<article>Redirected story</article>",
      ok: true,
    });
    expect(fetchCalls).toBe(2);
  });

  test.each([
    "http://192.168.1.1/private",
    "http://localhost./private",
    "http://x.localhost./private",
  ])(
    "rejects an injected visible private redirect destination %s",
    async (location) => {
      let fetchCalls = 0;
      const response = await handleReaderRequest(
        request("https://article.example/story"),
        sender,
        instance,
        async () => {
          fetchCalls++;
          return new Response(null, { headers: { location }, status: 302 });
        },
      );
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error).toBe("PRIVATE_URL");
      expect(fetchCalls).toBe(1);
    },
  );

  test("stops after five redirects", async () => {
    let fetchCalls = 0;
    const fetchImplementation: ReaderFetch = async () => {
      fetchCalls++;
      return new Response(null, {
        headers: { location: `/redirect-${fetchCalls}` },
        status: 302,
      });
    };
    const response = await handleReaderRequest(
      request("https://article.example/story"),
      sender,
      instance,
      fetchImplementation,
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toBe("TOO_MANY_REDIRECTS");
    expect(fetchCalls).toBe(6);
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
            "content-length": String(5 * 1024 * 1024 + 1),
            "content-type": "text/html",
          },
        }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toBe("TOO_LARGE");
  });
});
