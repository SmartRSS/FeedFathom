import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  discoverWebSub,
  requestHubSubscription,
  verifyHubSignature,
} from "#features/feeds/websub.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type FetchImplementation = (
  ...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const setFetch = (implementation: FetchImplementation) => {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
};

describe("discoverWebSub", () => {
  test("prefers the HTTP Link header over the feed body", () => {
    const headers = new Headers({
      link: '<https://hub.example/>; rel="hub", <https://feed.example/atom.xml>; rel="self"',
    });
    expect(
      discoverWebSub(headers, "", "https://feed.example/atom.xml"),
    ).toEqual({
      hubUrl: "https://hub.example/",
      topicUrl: "https://feed.example/atom.xml",
    });
  });

  test("falls back to an atom:link-namespaced RSS body", () => {
    const rss = `<?xml version="1.0"?><rss xmlns:atom="http://www.w3.org/2005/Atom"><channel><atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/><atom:link rel="self" href="https://example.com/feed"/></channel></rss>`;
    expect(
      discoverWebSub(new Headers(), rss, "https://example.com/feed"),
    ).toEqual({
      hubUrl: "https://pubsubhubbub.appspot.com/",
      topicUrl: "https://example.com/feed",
    });
  });

  test("falls back to a plain Atom feed body", () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><link rel="hub" href="https://hub.example/"/><link rel="self" href="https://example.com/atom.xml"/></feed>`;
    expect(
      discoverWebSub(new Headers(), atom, "https://example.com/atom.xml"),
    ).toEqual({
      hubUrl: "https://hub.example/",
      topicUrl: "https://example.com/atom.xml",
    });
  });

  test("falls back to the feed's own URL when no self link is present", () => {
    const atom = `<link rel="hub" href="https://hub.example/"/>`;
    expect(
      discoverWebSub(new Headers(), atom, "https://example.com/feed"),
    ).toEqual({
      hubUrl: "https://hub.example/",
      topicUrl: "https://example.com/feed",
    });
  });

  test("returns undefined when no hub is advertised", () => {
    expect(
      discoverWebSub(new Headers(), "<rss></rss>", "https://example.com/feed"),
    ).toBeUndefined();
  });

  test("rejects a hub URL that resolves to a private address", () => {
    const body = `<link rel="hub" href="http://127.0.0.1:6379/"/><link rel="self" href="https://example.com/feed"/>`;
    expect(
      discoverWebSub(new Headers(), body, "https://example.com/feed"),
    ).toBeUndefined();
  });

  test("rejects a topic URL that resolves to a private address", () => {
    const body = `<link rel="hub" href="https://hub.example/"/><link rel="self" href="http://169.254.169.254/"/>`;
    expect(
      discoverWebSub(new Headers(), body, "https://example.com/feed"),
    ).toBeUndefined();
  });

  test("falls back to a JSON Feed's own hubs array", () => {
    const body = JSON.stringify({
      hubs: [{ type: "WebSub", url: "https://hub.example/" }],
      items: [],
      title: "Feed",
    });
    expect(
      discoverWebSub(new Headers(), body, "https://example.com/feed.json"),
    ).toEqual({
      hubUrl: "https://hub.example/",
      topicUrl: "https://example.com/feed.json",
    });
  });

  test("ignores JSON Feed hubs of a different type", () => {
    const body = JSON.stringify({
      hubs: [{ type: "rssCloud", url: "https://hub.example/" }],
      items: [],
    });
    expect(
      discoverWebSub(new Headers(), body, "https://example.com/feed.json"),
    ).toBeUndefined();
  });
});

describe("verifyHubSignature", () => {
  const secret = "s3cr3t";
  const body = Buffer.from("hello world");

  test("accepts a valid sha256 signature", () => {
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyHubSignature(secret, signature, body)).toBe(true);
  });

  test("accepts a valid sha1 signature (the original spec's minimum)", () => {
    const signature = `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
    expect(verifyHubSignature(secret, signature, body)).toBe(true);
  });

  test("rejects a tampered signature", () => {
    expect(verifyHubSignature(secret, "sha256=deadbeef", body)).toBe(false);
  });

  test("rejects the right shape signed with the wrong secret", () => {
    const signature = `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`;
    expect(verifyHubSignature(secret, signature, body)).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifyHubSignature(secret, null, body)).toBe(false);
  });

  test("rejects an unsupported algorithm", () => {
    const signature = `md5=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyHubSignature(secret, signature, body)).toBe(false);
  });
});

describe("requestHubSubscription", () => {
  test("blocks a hub URL that resolves to a private address before any network call", async () => {
    let fetchCalled = false;
    setFetch(async () => {
      fetchCalled = true;
      return new Response(null, { status: 202 });
    });
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubUrl: "http://169.254.169.254/",
      mode: "subscribe",
      secret: "x",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({
      error: "Hub URL resolves to a private address",
      ok: false,
    });
    expect(fetchCalled).toBe(false);
  });

  test("posts the expected form fields and treats a 2xx as accepted", async () => {
    let capturedBody: URLSearchParams | undefined;
    let capturedMethod: string | undefined;
    setFetch(async (_input, init) => {
      capturedMethod = init?.method;
      if (init?.body instanceof URLSearchParams) capturedBody = init.body;
      return new Response(null, { status: 202 });
    });
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubUrl: "https://hub.example/",
      leaseSeconds: 86_400,
      mode: "subscribe",
      secret: "s3cr3t",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({ ok: true });
    expect(capturedMethod).toBe("POST");
    expect(capturedBody?.get("hub.mode")).toBe("subscribe");
    expect(capturedBody?.get("hub.topic")).toBe("https://example.com/feed");
    expect(capturedBody?.get("hub.callback")).toBe(
      "https://us.example/callback/token",
    );
    expect(capturedBody?.get("hub.secret")).toBe("s3cr3t");
    expect(capturedBody?.get("hub.lease_seconds")).toBe("86400");
    // Some hubs (WordPress.com's pushpress hub confirmed) reject a
    // subscribe request outright without this, even though verification is
    // always async regardless of what's sent here.
    expect(capturedBody?.get("hub.verify")).toBe("async");
  });

  test("treats a non-2xx hub response as failure", async () => {
    setFetch(async () => new Response(null, { status: 500 }));
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubUrl: "https://hub.example/",
      mode: "subscribe",
      secret: "x",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({
      error: "Hub responded with 500",
      ok: false,
    });
  });

  test("treats a network error as failure instead of throwing", async () => {
    setFetch(async () => {
      throw new Error("boom");
    });
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubUrl: "https://hub.example/",
      mode: "subscribe",
      secret: "x",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({ error: "boom", ok: false });
  });
});
