import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Page } from "@playwright/test";
import type { ReaderResponse } from "../../src/extension/extension-types";
import { installApiFixture } from "./api-fixture";

const extensionPath = fileURLToPath(
  new URL("../../ext/build-ch", import.meta.url),
);

async function setInstance(page: Page, extensionId: string, instance: string) {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const input = page.locator("#instance");
  await input.fill(instance);
  await input.dispatchEvent("change");
  await page.waitForFunction(
    async (expected) =>
      (await chrome.storage.sync.get("instance"))["instance"] === expected,
    instance,
  );
}

async function installFeedCollector(page: Page) {
  await page.evaluate(() => {
    const messages: unknown[] = [];
    Reflect.set(globalThis, "feedMessages", messages);
    chrome.runtime.onMessage.addListener((message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "action" in message &&
        message.action === "list-feeds"
      )
        messages.push(message);
    });
  });
}

async function feedMessages(page: Page) {
  return await page.evaluate(() => Reflect.get(globalThis, "feedMessages"));
}

async function waitForFeedTitle(page: Page, title: string) {
  await page.waitForFunction(
    (expected) => {
      const messages = Reflect.get(globalThis, "feedMessages");
      return (
        Array.isArray(messages) &&
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "feedsData" in message &&
            Array.isArray(message.feedsData) &&
            message.feedsData.some(
              (feed: unknown) =>
                typeof feed === "object" &&
                feed !== null &&
                "title" in feed &&
                feed.title === expected,
            ),
        )
      );
    },
    title,
    { timeout: 5_000 },
  );
}

function probeCapabilities(page: Page): Promise<ReaderResponse> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(
          () => reject(new Error("Reader capability response timed out")),
          5_000,
        );
        const receive = (event: MessageEvent) => {
          const response = event.data;
          if (
            event.source !== window ||
            response?.action !== "capabilities" ||
            response?.channel !== "feedfathom-reader" ||
            response?.id !== id ||
            response?.type !== "response" ||
            response?.version !== 1
          )
            return;
          clearTimeout(timeout);
          removeEventListener("message", receive);
          resolve(response);
        };
        addEventListener("message", receive);
        window.postMessage(
          {
            action: "capabilities",
            channel: "feedfathom-reader",
            id,
            type: "request",
            version: 1,
          },
          location.origin,
        );
      }),
  );
}

function probeFetch(page: Page, url: string): Promise<ReaderResponse> {
  return page.evaluate(
    (targetUrl) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(
          () => reject(new Error("Reader fetch response timed out")),
          20_000,
        );
        const receive = (event: MessageEvent) => {
          const response = event.data;
          if (
            event.source !== window ||
            response?.action !== "fetch" ||
            response?.channel !== "feedfathom-reader" ||
            response?.id !== id ||
            response?.type !== "response" ||
            response?.version !== 1
          )
            return;
          clearTimeout(timeout);
          removeEventListener("message", receive);
          resolve(response);
        };
        addEventListener("message", receive);
        window.postMessage(
          {
            action: "fetch",
            channel: "feedfathom-reader",
            id,
            type: "request",
            url: targetUrl,
            version: 1,
          },
          location.origin,
        );
      }),
    url,
  );
}

test("keeps feed menus current across SPA navigation", async ({ baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const profile = await mkdtemp(`${tmpdir()}/feedfathom-extension-`);
  const context = await chromium.launchPersistentContext(profile, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).hostname;
    const optionsPage = await context.newPage();
    const appPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await installFeedCollector(optionsPage);
    await appPage.route("**/extension-menu-*", async (route) => {
      await route.fulfill({
        body: '<!doctype html><html><head><link rel="alternate" type="application/rss+xml" title="Initial" href="/initial.xml"></head><body></body></html>',
        contentType: "text/html",
      });
    });

    await appPage.goto(`${new URL(baseURL).origin}/extension-menu-initial`);
    await waitForFeedTitle(optionsPage, "Initial");

    await appPage.evaluate(() => {
      const link = document.querySelector("link[rel=alternate]");
      if (!(link instanceof HTMLLinkElement))
        throw new Error("feed link missing");
      history.pushState({}, "", "/extension-menu-stale");
      link.title = "Stale";
      link.href = "/stale.xml";
      document.body.append(document.createElement("div"));
    });
    await appPage.waitForTimeout(100);
    await appPage.evaluate(() => {
      const link = document.querySelector("link[rel=alternate]");
      if (!(link instanceof HTMLLinkElement))
        throw new Error("feed link missing");
      history.pushState({}, "", "/extension-menu-latest");
      link.title = "Latest";
      link.href = "/latest.xml";
      document.body.append(document.createElement("div"));
    });
    await waitForFeedTitle(optionsPage, "Latest");

    const afterNavigation = await feedMessages(optionsPage);
    expect(JSON.stringify(afterNavigation)).not.toContain("Stale");

    const beforeVisibility = Array.isArray(afterNavigation)
      ? afterNavigation.length
      : 0;
    await appPage.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await optionsPage.waitForFunction((count) => {
      const messages = Reflect.get(globalThis, "feedMessages");
      return Array.isArray(messages) && messages.length > count;
    }, beforeVisibility);
    const afterVisibility = await feedMessages(optionsPage);
    expect(
      JSON.stringify(afterVisibility).match(/Latest/g)?.length,
    ).toBeGreaterThan(1);

    const settledCount = Array.isArray(afterVisibility)
      ? afterVisibility.length
      : 0;
    await appPage.evaluate(() =>
      document.body.append(document.createElement("div")),
    );
    await appPage.waitForTimeout(2_000);
    expect(await feedMessages(optionsPage)).toHaveLength(settledCount);
  } finally {
    await context.close();
    await rm(profile, { recursive: true });
  }
});

test("uses the real extension bridge only on its configured origin", async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const profile = await mkdtemp(`${tmpdir()}/feedfathom-extension-`);
  const context = await chromium.launchPersistentContext(profile, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).hostname;
    const optionsPage = await context.newPage();
    const appPage = await context.newPage();
    const browserFailures: string[] = [];
    appPage.on("pageerror", (error) => browserFailures.push(error.message));
    appPage.on("console", (message) => {
      if (message.type() === "error") browserFailures.push(message.text());
    });
    await installApiFixture(appPage);
    // The app's own service worker registers and can end up controlling
    // appPage, intercepting same-origin fetches (including /api/tree) from
    // *inside* the worker's own execution context -- outside what
    // page.route() covers, since that only intercepts requests the page
    // itself initiates. context.route() also covers service-worker-
    // originated requests, so this catches whatever the page-level mock in
    // installApiFixture doesn't, without needing to block or fake out
    // service worker registration itself (this test needs the extension's
    // own real service worker, so context-wide serviceWorkers: "block"
    // isn't an option here).
    await context.route("**/api/**", (route) =>
      route.fulfill({ body: "[]", contentType: "application/json" }),
    );

    const origin = new URL(baseURL).origin;
    await setInstance(optionsPage, extensionId, origin);
    await appPage.goto(origin);
    await expect(appPage.getByRole("combobox")).toContainText("Reader plain");
    const allowed = await probeCapabilities(appPage);
    expect(allowed).toEqual({
      action: "capabilities",
      available: true,
      channel: "feedfathom-reader",
      id: allowed.id,
      ok: true,
      type: "response",
      version: 1,
    });

    const refusedOrigin = new URL(origin);
    refusedOrigin.hostname =
      refusedOrigin.hostname === "localhost" ? "127.0.0.1" : "localhost";
    await setInstance(optionsPage, extensionId, refusedOrigin.origin);
    await appPage.reload();
    const refused = await probeCapabilities(appPage);
    expect(refused).toEqual({
      action: "capabilities",
      channel: "feedfathom-reader",
      error: "UNAUTHORIZED",
      id: refused.id,
      ok: false,
      type: "response",
      version: 1,
    });
    await expect(appPage.getByRole("combobox")).toHaveCount(0);
    expect(browserFailures).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true });
  }
});

test("fails closed on opaque redirects and blocks terminal-dot private targets", async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");

  let port = 0;
  let privateRequests = 0;
  let publicArticleRequests = 0;
  let publicRedirectRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://server.invalid");
    if (url.pathname === "/redirect") {
      publicRedirectRequests++;
      const target =
        url.searchParams.get("target") === "private"
          ? `http://localhost.:${port}/private`
          : `http://redirect.reader.test:${port}/article`;
      response.writeHead(302, { location: target });
      response.end();
      return;
    }
    if (url.pathname === "/article") {
      publicArticleRequests++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<article>Browser redirect</article>");
      return;
    }
    if (url.pathname === "/private") {
      privateRequests++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<article>Private endpoint</article>");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Reader test server did not bind a TCP port");
  port = address.port;

  try {
    const profile = await mkdtemp(`${tmpdir()}/feedfathom-extension-`);
    try {
      const context = await chromium.launchPersistentContext(profile, {
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          "--host-resolver-rules=MAP public.reader.test 127.0.0.1, MAP redirect.reader.test 127.0.0.1",
        ],
        channel: "chromium",
        headless: true,
      });
      try {
        const serviceWorker =
          context.serviceWorkers()[0] ??
          (await context.waitForEvent("serviceworker"));
        const extensionId = new URL(serviceWorker.url()).hostname;
        const optionsPage = await context.newPage();
        const appPage = await context.newPage();
        await installApiFixture(appPage);

        const origin = new URL(baseURL).origin;
        await setInstance(optionsPage, extensionId, origin);
        await appPage.goto(origin);

        const direct = await probeFetch(
          appPage,
          `http://localhost.:${port}/private`,
        );
        expect(direct).toEqual({
          action: "fetch",
          channel: "feedfathom-reader",
          error: "PRIVATE_URL",
          id: direct.id,
          ok: false,
          type: "response",
          version: 1,
        });
        expect(privateRequests).toBe(0);

        /* eslint-disable no-await-in-loop -- Requests and endpoint-count assertions are intentionally ordered. */
        for (const target of ["public", "private"]) {
          const redirected = await probeFetch(
            appPage,
            `http://public.reader.test:${port}/redirect?target=${target}`,
          );
          expect(redirected).toEqual({
            action: "fetch",
            channel: "feedfathom-reader",
            error: "INVALID_RESPONSE",
            id: redirected.id,
            ok: false,
            type: "response",
            version: 1,
          });
          expect(publicArticleRequests).toBe(0);
          expect(privateRequests).toBe(0);
        }
        /* eslint-enable no-await-in-loop */
        expect(publicRedirectRequests).toBe(2);
      } finally {
        await context.close();
      }
    } finally {
      await rm(profile, { recursive: true });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
