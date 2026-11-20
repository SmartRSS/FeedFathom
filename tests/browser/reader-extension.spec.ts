import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import {
  isReaderResponseForRequest,
  readerCapabilitiesRequest,
  readerFetchRequest,
  type ReaderRequest,
  type ReaderResponse,
} from "#shared/reader-bridge.ts";
import { installApiFixture } from "./api-fixture.ts";
import { expect, setInstance, test } from "./extension-fixture.ts";

async function recordStoredFeeds(page: Page) {
  await page.evaluate(() => {
    const history: string[][] = [];
    Reflect.set(globalThis, "storedFeeds", history);
    chrome.storage.session.onChanged.addListener((changes) => {
      const feeds: unknown = changes["feedsData"]?.newValue;
      if (Array.isArray(feeds))
        history.push(feeds.map((feed: { title: string }) => feed.title));
    });
  });
}

async function storedFeedHistory(page: Page): Promise<string[][]> {
  return await page.evaluate(() => Reflect.get(globalThis, "storedFeeds"));
}

async function waitForStoredFeeds(page: Page, titles: string[]) {
  await page.waitForFunction(
    (expected) => {
      const history = Reflect.get(globalThis, "storedFeeds");
      return (
        Array.isArray(history) &&
        JSON.stringify(history.at(-1)) === JSON.stringify(expected)
      );
    },
    titles,
    { timeout: 5_000 },
  );
}

async function postBridgeRequest(
  page: Page,
  request: ReaderRequest,
  timeoutMs: number,
): Promise<unknown> {
  return await page.evaluate(
    ({ message, timeout }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Reader bridge response timed out")),
          timeout,
        );
        const receive = (event: MessageEvent) => {
          const data: unknown = event.data;
          if (
            event.source !== window ||
            typeof data !== "object" ||
            data === null ||
            !("type" in data) ||
            data.type !== "response" ||
            !("id" in data) ||
            data.id !== message.id
          )
            return;
          clearTimeout(timer);
          removeEventListener("message", receive);
          resolve(data);
        };
        addEventListener("message", receive);
        window.postMessage(message, location.origin);
      }),
    { message: request, timeout: timeoutMs },
  );
}

async function probeCapabilities(page: Page): Promise<ReaderResponse> {
  const request = readerCapabilitiesRequest();
  const response = await postBridgeRequest(page, request, 5_000);
  if (!isReaderResponseForRequest(response, request))
    throw new Error(`Not a capabilities response: ${JSON.stringify(response)}`);
  return response;
}

async function probeFetch(page: Page, url: string): Promise<ReaderResponse> {
  const request = readerFetchRequest(url);
  const response = await postBridgeRequest(page, request, 20_000);
  if (!isReaderResponseForRequest(response, request))
    throw new Error(`Not a fetch response: ${JSON.stringify(response)}`);
  return response;
}

test("keeps the found feeds current across SPA navigation", async ({
  baseURL,
  extension,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const { context, id: extensionId } = extension;
  const optionsPage = await context.newPage();
  const appPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await recordStoredFeeds(optionsPage);
  await appPage.route("**/extension-menu-*", async (route) => {
    await route.fulfill({
      body: '<!doctype html><html><head><link rel="alternate" type="application/rss+xml" title="Initial" href="/initial.xml"></head><body></body></html>',
      contentType: "text/html",
    });
  });

  await appPage.goto(`${new URL(baseURL).origin}/extension-menu-initial`);
  await waitForStoredFeeds(optionsPage, ["Initial"]);

  await appPage.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const link = document.querySelector("link[rel=alternate]");
        if (!(link instanceof HTMLLinkElement))
          throw new Error("feed link missing");
        const probe = new MutationObserver(() => {
          probe.disconnect();
          resolve();
        });
        probe.observe(document.body, { childList: true });
        history.pushState({}, "", "/extension-menu-stale");
        link.title = "Stale";
        link.href = "/stale.xml";
        document.body.append(document.createElement("div"));
      }),
  );
  await appPage.evaluate(() => {
    const link = document.querySelector("link[rel=alternate]");
    if (!(link instanceof HTMLLinkElement))
      throw new Error("feed link missing");
    history.pushState({}, "", "/extension-menu-latest");
    link.title = "Latest";
    link.href = "/latest.xml";
    document.body.append(document.createElement("div"));
  });
  await waitForStoredFeeds(optionsPage, ["Latest"]);

  expect((await storedFeedHistory(optionsPage)).flat()).not.toContain("Stale");
});

test("uses the real extension bridge only on its configured origin", async ({
  baseURL,
  extension,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const { context, id: extensionId } = extension;
  const optionsPage = await context.newPage();
  const appPage = await context.newPage();
  const browserFailures: string[] = [];
  appPage.on("pageerror", (error) => browserFailures.push(error.message));
  appPage.on("console", (message) => {
    if (message.type() === "error") browserFailures.push(message.text());
  });
  await installApiFixture(context);
  const openArticle = async () => {
    await appPage
      .locator("button.source")
      .filter({ hasText: "Tech News" })
      .click();
    await expect(appPage.getByText("Feed article content")).toBeVisible();
  };
  const modes = appPage.getByRole("combobox", {
    name: "Article display mode",
  });

  const origin = new URL(baseURL).origin;
  await setInstance(optionsPage, extensionId, origin);
  await appPage.goto(origin);
  await openArticle();
  await expect(modes).toContainText("Reader (plain text)");
  const allowed = await probeCapabilities(appPage);
  expect(allowed).toMatchObject({ available: true, ok: true });

  const refusedOrigin = new URL(origin);
  refusedOrigin.hostname =
    refusedOrigin.hostname === "localhost" ? "127.0.0.1" : "localhost";
  await setInstance(optionsPage, extensionId, refusedOrigin.origin);
  await appPage.reload();
  const refused = await probeCapabilities(appPage);
  expect(refused).toMatchObject({ error: "UNAUTHORIZED", ok: false });
  await openArticle();
  await expect(modes).toHaveCount(0);
  expect(browserFailures).toEqual([]);
});

test.describe(() => {
  test.use({
    extensionArgs: [
      "--host-resolver-rules=MAP public.reader.test 127.0.0.1, MAP redirect.reader.test 127.0.0.1",
    ],
  });

  test("fails closed on opaque redirects and blocks terminal-dot private targets", async ({
    baseURL,
    extension,
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
      const { context, id: extensionId } = extension;
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
      expect(direct).toMatchObject({ error: "PRIVATE_URL", ok: false });
      expect(privateRequests).toBe(0);

      /* eslint-disable no-await-in-loop -- Requests and endpoint-count assertions are intentionally ordered. */
      for (const target of ["public", "private"]) {
        const redirected = await probeFetch(
          appPage,
          `http://public.reader.test:${port}/redirect?target=${target}`,
        );
        expect(redirected).toMatchObject({
          error: "INVALID_RESPONSE",
          ok: false,
        });
        expect(publicArticleRequests).toBe(0);
        expect(privateRequests).toBe(0);
      }
      /* eslint-enable no-await-in-loop */
      expect(publicRedirectRequests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
