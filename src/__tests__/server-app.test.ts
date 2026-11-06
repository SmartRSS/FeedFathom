import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { maximumFeedBodyBytes } from "#platform/http/http-cache-store.ts";
import { createServerApp } from "../server-app.ts";
import {
  createDependencies,
  appFor,
  send,
  get,
  post,
  authenticated,
} from "./server-harness.ts";

test.each([
  ["/settings", "text/html", 200, "text/html"],
  ["/index.html", "text/html", 200, "text/html"],
  ["/api/session", "text/html", 200, "application/json"],
  ["/api/missing", "text/html", 404, null],
  ["/assets/missing", "text/html", 404, null],
  ["/assets/missing.js", "text/html", 404, null],
  ["/settings", "application/json", 404, null],
])("serves %s selectively", async (path, accept, status, contentType) => {
  const app = await appFor(createDependencies(), true);
  const response = await get(app, path, { headers: { accept } });

  expect(response.status).toBe(status);
  if (contentType)
    expect(response.headers.get("content-type")).toContain(contentType);
});

test.each([
  ["/", false],
  ["/index.html", false],
  ["/settings", false],
  ["/", true],
  ["/index.html", true],
  ["/settings", true],
])(
  "restricts scripts on the %s shell, allowing Turnstile only when enabled: %p",
  async (path, turnstileEnabled) => {
    const dependencies = createDependencies();
    if (turnstileEnabled) dependencies.config.TURNSTILE_SITE_KEY = "site-key";
    const app = await appFor(dependencies, true);
    const response = await get(app, path, { headers: { accept: "text/html" } });

    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toStartWith("script-src 'self' 'sha256-");
    expect(policy).not.toContain("default-src");
    expect(policy.includes("https://challenges.cloudflare.com")).toBe(
      turnstileEnabled,
    );
  },
);

// A cookie whose sid resolves to nobody -- expired, revoked by logout or a
// password reset, or never issued -- is exactly as unauthorised as no cookie.
test.each([
  ["GET", "/api/preview?feedUrl=https%3A%2F%2Ffeed.example%2Frss"],
  ["GET", "/api/find?link=https%3A%2F%2Fsite.example%2F"],
  ["GET", "/api/article?article=1"],
  ["GET", "/api/tree"],
  ["GET", "/api/events"],
  ["GET", "/api/folders"],
  ["GET", "/api/options/sessions"],
  ["DELETE", "/api/options/sessions"],
  ["DELETE", "/api/options/sessions/7"],
  ["POST", "/api/articles"],
])(
  "rejects %s %s with no cookie and with an unknown one",
  async (method, path) => {
    const app = await appFor(createDependencies());
    const body = method === "POST" ? { sources: [3] } : undefined;

    const responses = await Promise.all(
      [false, true].map((auth) => send(app, method, path, body, { auth })),
    );

    const outcomes = await Promise.all(
      responses.map(async (r) => [r.status, await r.json()]),
    );
    expect({ missingCookie: outcomes[0], unknownCookie: outcomes[1] }).toEqual({
      missingCookie: [401, { error: "Unauthorized" }],
      unknownCookie: [401, { error: "Unauthorized" }],
    });
  },
);

test("rejects synthetic requests to /healthcheck", async () => {
  const app = await appFor(createDependencies());
  const response = await get(app, "/healthcheck", {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });

  expect(response.status).toBe(403);
});

test("allows loopback healthchecks", async () => {
  const app = await appFor(createDependencies());
  app.listen(0);
  try {
    const origin = `http://127.0.0.1:${app.server?.port}`;

    expect((await fetch(`${origin}/healthcheck`)).status).toBe(200);
  } finally {
    await app.stop();
  }
});

test("rejects an oversized body before any handler runs", async () => {
  const app = await appFor(createDependencies());
  app.listen(0);
  try {
    const origin = `http://127.0.0.1:${app.server?.port}`;
    const oversized = "x".repeat(maximumFeedBodyBytes + 1);

    const response = await fetch(`${origin}/api/login`, {
      body: JSON.stringify({ email: oversized }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(413);
  } finally {
    await app.stop();
  }
});

test.each([
  ["/api/login", { email: 1 }, 422],
  ["/api/register", {}, 422],
  ["/api/mail", {}, 422],
])("keeps POST %s public", async (path, body, status) => {
  const app = await appFor(createDependencies());
  const response = await post(app, path, body);

  expect(response.status).toBe(status);
});

test("logs a slow request with its route pattern, never the raw query string", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  // A tiny threshold stands in for an artificially slow handler: every
  // request that completes at all is "slow" against it.
  dependencies.config.SLOW_REQUEST_MS = 0;
  dependencies.sourcesDataService.getFavicon = async () =>
    "data:image/png;base64,AAAA";
  const app = await appFor(dependencies);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    const response = await get(app, "/api/favicon/7?v=abc123", { auth: true });

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line: unknown = log.mock.calls[0]?.[0];
    if (typeof line !== "string") throw new Error("Expected a logged line");
    expect(line).toMatch(/^GET \/api\/favicon\/:id 200 \d+$/);
    expect(line).not.toContain("v=abc123");
    expect(line).not.toContain("?");
    expect(line).not.toContain("/7");
  } finally {
    log.mockRestore();
  }
});

test("a request under the threshold logs nothing", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.config.SLOW_REQUEST_MS = 600_000;
  const app = await appFor(dependencies);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    const response = await get(app, "/api/session", { auth: true });

    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

// The internal healthcheck runs constantly and carries no useful signal, so
// it stays out of the slow-request log even when it is the slowest thing an
// instance ever serves.
test("never logs the healthcheck route, however slow", async () => {
  const dependencies = createDependencies();
  dependencies.config.SLOW_REQUEST_MS = 0;
  const app = await appFor(dependencies);
  app.listen(0);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    const origin = `http://127.0.0.1:${app.server?.port}`;
    const response = await fetch(`${origin}/healthcheck`);

    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    await app.stop();
  }
});

test("cache headers: /assets/* is immutable, index.html is no-cache", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "feedfathom-spa-"));
  try {
    // Create directory structure with files
    await Bun.write(`${tmpDir}/index.html`, "<html>test</html>");
    await Bun.write(`${tmpDir}/assets/x-abc123.js`, "console.log('test');");

    const dependencies = createDependencies();
    dependencies.config.production = true;
    const appWithSpa = await createServerApp(dependencies, {
      spaDirectory: tmpDir,
    });

    // Test /assets/* → immutable
    const assetResponse = await get(appWithSpa, "/assets/x-abc123.js");
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );

    // Test / → no-cache
    const indexResponse = await get(appWithSpa, "/");
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("Cache-Control")).toBe("no-cache");

    // Test /index.html → no-cache
    const indexHtmlResponse = await get(appWithSpa, "/index.html");
    expect(indexHtmlResponse.status).toBe(200);
    expect(indexHtmlResponse.headers.get("Cache-Control")).toBe("no-cache");

    // Test SPA fallback (404 with Accept: text/html returns index.html) → no-cache
    const spaFallbackResponse = await get(appWithSpa, "/some/spa/route", {
      headers: { accept: "text/html" },
    });
    expect(spaFallbackResponse.status).toBe(200);
    expect(spaFallbackResponse.headers.get("Cache-Control")).toBe("no-cache");
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});
