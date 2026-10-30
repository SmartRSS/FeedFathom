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
} from "#shared/extension-types.ts";
import { handleReaderRequest, type ReaderFetch } from "../reader-fetch.ts";

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
    expect(
      isReaderResponse({
        action: "fetch",
        channel: readerBridgeChannel,
        error: "UNKNOWN",
        id: validRequest.id,
        ok: false,
        type: "response",
        version: readerBridgeVersion,
      }),
    ).toBe(false);
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

// Page bodies as they arrive on the wire. Markup is ASCII, so a string part is
// one byte per char; non-ASCII text is always a literal byte array, never a JS
// string, which would already be decoded.
const asciiCodes = (text: string) =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const page = (title: number[], head = "") =>
  Uint8Array.from([
    ...asciiCodes(`<html><head>${head}</head><body><h1>`),
    ...title,
    ...asciiCodes("</h1></body></html>"),
  ]);
const privet = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // "Привет" in windows-1251
const nihongo = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]; // "日本語" in Shift_JIS
const zazolcUtf8 = [0x5a, 0x61, 0xc5, 0xbc, 0xc3, 0xb3, 0xc5, 0x82, 0xc4, 0x87]; // "Zażółć" in UTF-8

const readerHtml = async (
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
) => {
  const response = await handleReaderRequest(
    request("https://article.example/story"),
    sender,
    instance,
    async () =>
      new Response(body, { headers: { "content-type": contentType } }),
  );
  return response.ok && response.action === "fetch" ? response.html : "";
};

describe("reader page charset", () => {
  test("decodes the Content-Type charset", async () => {
    expect(
      await readerHtml(page(privet), "text/html; charset=windows-1251"),
    ).toContain("<h1>Привет</h1>");
  });

  test("sniffs <meta charset> when the header has none", async () => {
    expect(
      await readerHtml(
        page(nihongo, '<meta charset="Shift_JIS">'),
        "text/html",
      ),
    ).toContain("<h1>日本語</h1>");
  });

  test("sniffs an http-equiv Content-Type meta", async () => {
    const head =
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">';
    expect(await readerHtml(page(privet, head), "text/html")).toContain(
      "<h1>Привет</h1>",
    );
  });

  test("lets a BOM win over a wrong header", async () => {
    const utf16le = asciiCodes("<h1>OK</h1>").flatMap((code) => [code, 0]);
    const body = Uint8Array.from([0xff, 0xfe, ...utf16le]);
    expect(await readerHtml(body, "text/html; charset=windows-1251")).toBe(
      "<h1>OK</h1>",
    );
  });

  test("falls back to UTF-8 on an unknown label", async () => {
    expect(
      await readerHtml(page(zazolcUtf8), "text/html; charset=not-a-charset"),
    ).toContain("<h1>Zażółć</h1>");
  });

  // HTML's prescan, not the feed rules: an unknown header label is ignored,
  // and comments and unknown meta labels don't stop the search.
  test.each([
    ["an unknown header label", "<meta charset=windows-1251>", "charset=None"],
    [
      "a commented-out meta",
      "<!-- <meta charset=utf-8> --><meta charset=windows-1251>",
      "",
    ],
    [
      "an unknown first meta",
      "<meta charset=bogus><meta charset=windows-1251>",
      "",
    ],
  ])("sniffs the meta past %s", async (_name, head, parameter) => {
    const contentType = parameter ? `text/html; ${parameter}` : "text/html";
    expect(await readerHtml(page(privet, head), contentType)).toContain(
      "<h1>Привет</h1>",
    );
  });

  // A meta read as ASCII can't truly be UTF-16, and x-user-defined means
  // windows-1252 there (the HTML spec's prescan rules).
  test.each([
    ["utf-16", zazolcUtf8, "<h1>Zażółć</h1>"],
    ["x-user-defined", [0x63, 0x61, 0x66, 0xe9], "<h1>café</h1>"],
  ])(
    "reads a meta that declares %s as the spec says",
    async (label, title, expected) => {
      expect(
        await readerHtml(page(title, `<meta charset="${label}">`), "text/html"),
      ).toContain(expected);
    },
  );
});
