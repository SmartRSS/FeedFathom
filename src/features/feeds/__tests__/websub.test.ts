import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  discoverWebSub,
  type HubPoster,
  requestHubSubscription,
  verifyHubSignature,
} from "#features/feeds/websub.ts";

// Stands in for HttpClient.post, which is what carries the reservation, the
// block check and Retry-After for the hub request.
function recordingPoster(
  respond: (url: string, body: URLSearchParams) => Promise<{ status: number }>,
) {
  const calls: Array<{ body: URLSearchParams; url: string }> = [];
  const poster: HubPoster = {
    async post(url, body) {
      calls.push({ body, url });
      return respond(url, body);
    },
  };
  return { calls, poster };
}

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
    const { calls, poster } = recordingPoster(async () => ({ status: 202 }));
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubPoster: poster,
      hubUrl: "http://169.254.169.254/",
      mode: "subscribe",
      secret: "x",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({
      error: "Hub URL resolves to a private address",
      ok: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("posts the expected form fields and treats a 2xx as accepted", async () => {
    const { calls, poster } = recordingPoster(async () => ({ status: 202 }));
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubPoster: poster,
      hubUrl: "https://hub.example/",
      leaseSeconds: 86_400,
      mode: "subscribe",
      secret: "s3cr3t",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://hub.example/");
    const body = calls[0]?.body;
    expect(body?.get("hub.mode")).toBe("subscribe");
    expect(body?.get("hub.topic")).toBe("https://example.com/feed");
    expect(body?.get("hub.callback")).toBe("https://us.example/callback/token");
    expect(body?.get("hub.secret")).toBe("s3cr3t");
    expect(body?.get("hub.lease_seconds")).toBe("86400");
    // Some hubs (WordPress.com's pushpress hub confirmed) reject a
    // subscribe request outright without this, even though verification is
    // always async regardless of what's sent here.
    expect(body?.get("hub.verify")).toBe("async");
  });

  test("treats a non-2xx hub response as failure", async () => {
    const { poster } = recordingPoster(async () => ({ status: 500 }));
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubPoster: poster,
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

  // Including a deferral: the hub's own back-off reaches this as a throw now
  // that the request goes through the client, and it must not escape into
  // parseSource.
  test("treats a network error as failure instead of throwing", async () => {
    const { poster } = recordingPoster(async () => {
      throw new Error("boom");
    });
    const result = await requestHubSubscription({
      callbackUrl: "https://us.example/callback/token",
      hubPoster: poster,
      hubUrl: "https://hub.example/",
      mode: "subscribe",
      secret: "x",
      topicUrl: "https://example.com/feed",
    });
    expect(result).toEqual({ error: "boom", ok: false });
  });
});
