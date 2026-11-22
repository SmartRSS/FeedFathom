import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { Value } from "typebox/value";
import { articlesRequest } from "#shared/contracts/requests.ts";
import { articlePageSize } from "#shared/contracts/limits.ts";
import { accountHeader } from "#shared/contracts/headers.ts";
import {
  articleResponse,
  articlesResponse,
  errorResponse,
  registrationResponse,
  successResponse,
  treeResponse,
  type TreeNode,
} from "#shared/contracts/responses.ts";
import type * as Dialogs from "../../src/spa/dialog.tsx";
import {
  installApiFixture,
  malformed,
  refuse,
  respond,
} from "./api-fixture.ts";

test.use({ serviceWorkers: "block" });

const browserFailures = new WeakMap<Page, string[]>();
const guardedResources = new Set(["document", "script", "stylesheet"]);

function guardBrowser(page: Page) {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      failures.push(`console.error: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    if (guardedResources.has(request.resourceType()))
      failures.push(`request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    const request: Request = response.request();
    if (guardedResources.has(request.resourceType()) && !response.ok())
      failures.push(`response ${response.status()}: ${response.url()}`);
  });
}

async function installReaderResponder(
  context: BrowserContext,
  available: boolean,
  article: "element-heavy" | "hostile" | "plain" = "plain",
) {
  await context.addInitScript(
    ([isAvailable, articleKind]) => {
      window.addEventListener("message", (event) => {
        const request = event.data;
        if (
          event.source !== window ||
          request?.channel !== "feedfathom-reader" ||
          request?.type !== "request" ||
          request?.version !== 1
        )
          return;

        if (request.action === "capabilities") {
          window.postMessage(
            isAvailable
              ? {
                  action: "capabilities",
                  available: true,
                  channel: "feedfathom-reader",
                  id: request.id,
                  ok: true,
                  type: "response",
                  version: 1,
                }
              : {
                  action: "capabilities",
                  channel: "feedfathom-reader",
                  error: "UNAVAILABLE",
                  id: request.id,
                  ok: false,
                  type: "response",
                  version: 1,
                },
            location.origin,
          );
        } else if (isAvailable && request.action === "fetch") {
          window.postMessage(
            {
              action: "fetch",
              channel: "feedfathom-reader",
              finalUrl: "https://articles.example/first",
              html:
                articleKind === "element-heavy"
                  ? `<html><body><article>${'<p>Paragraph text with <a href="/next">a link</a>.</p>'.repeat(24_000)}</article></body></html>`
                  : articleKind === "hostile"
                    ? `<html><head><title>Bridged article</title></head><body><article><h1>Bridged article</h1><p>${"Reader bridge content. ".repeat(40)}</p><p><img src="data:," alt="Hostile image" loading="eager" onerror="globalThis.readerHandlerRan = true"></p></article></body></html>`
                    : `<html><head><title>Bridged article</title></head><body><article><h1>Bridged article</h1><p>${"Reader bridge content. ".repeat(40)}</p><p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Bridged image" onerror="alert(1)"></p></article></body></html>`,
              id: request.id,
              ok: true,
              type: "response",
              version: 1,
            },
            location.origin,
          );
        }
      });
    },
    [available, article] as const,
  );
}

const pagedSummary = (id: number) => ({
  author: "Author",
  id,
  publishedAt: "2026-07-20T10:00:00.000Z",
  read: false,
  revision: null,
  sourceId: 3,
  title: `Article ${id}`,
  url: `https://articles.example/${id}`,
});

const fulfillPagedArticle = async (route: Route) => {
  const id = Number(new URL(route.request().url()).searchParams.get("article"));
  await respond(route, articleResponse, {
    author: "Author",
    content: `<p>Body ${id}</p>`,
    guid: `guid-${id}`,
    id,
    lastSeenInFeedAt: "2026-07-20T10:00:00.000Z",
    publishedAt: "2026-07-20T10:00:00.000Z",
    sourceId: 3,
    title: `Article ${id}`,
    updatedAt: null,
    url: `https://articles.example/${id}`,
  });
};

const articleOptions = (page: Page) =>
  page.locator(".article-list").getByRole("option");

const sourceRow = (page: Page, name = "Tech News") =>
  page.locator("button.source").filter({ hasText: name });

const selectSource = async (page: Page, name = "Tech News") => {
  await sourceRow(page, name).click();
};

const openApp = async (
  page: Page,
  options?: Parameters<typeof installApiFixture>[1],
  path = "/",
) => {
  const state = await installApiFixture(page, options);
  await page.goto(path);
  return state;
};

const sessionAnswer = (page: Page) =>
  page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/session",
  );

const intersectionsDelivered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const probe = new IntersectionObserver(() => {
          probe.disconnect();
          resolve();
        });
        probe.observe(document.body);
      }),
  );

test.beforeEach(async ({ page }) => {
  guardBrowser(page);
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? []).toEqual([]);
});

test("shows an all-caught-up empty state for a feed with no unread", async ({
  page,
}) => {
  await openApp(page);

  await sourceRow(page).first().click();
  await page.getByRole("button", { name: "delete articles" }).click();
  await expect(page.getByText("All caught up.")).toBeVisible();

  await expect(
    page.getByRole("listbox", { name: "Articles" }).getByRole("status"),
  ).toHaveCount(0);
});

test("opens a keyboard-dismissable context menu on tree rows", async ({
  page,
}) => {
  await openApp(page);

  await page.locator("button.source").first().click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);

  const row = sourceRow(page).first();
  await row.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Copy feed URL" }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Tab closes the context menu and moves focus on from its row", async ({
  page,
}) => {
  await openApp(page);

  const row = sourceRow(page).first();
  await row.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(row).not.toBeFocused();
});

test("keeps the context menu inside a narrow viewport", async ({ page }) => {
  await installApiFixture(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");

  await sourceRow(page)
    .first()
    .evaluate((row) => {
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.right - 4,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
  await expect(page.getByRole("menu")).toBeVisible();

  const menu = await page.locator(".context-menu").boundingBox();
  expect(menu).toBeTruthy();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("menuitem", { name: "Copy feed URL" }),
  ).toBeVisible();
});

test("renders the tree while its favicons are still loading", async ({
  page,
}) => {
  await installApiFixture(page);
  const rowCount = 50;
  await page.route("**/api/tree", async (route) => {
    await respond(route, treeResponse, {
      tree: Array.from({ length: rowCount }, (_, index): TreeNode => ({
        favicon: `/api/favicon/${index + 1}?v=1`,
        homeUrl: "https://news.example/",
        kind: "feed",
        name: `Feed ${index}`,
        type: "source",
        uid: String(index + 1),
        unreadCount: 0,
        xmlUrl: `https://news.example/${index}.xml`,
      })),
    });
  });
  const held: Route[] = [];
  await page.route("**/api/favicon/**", (route) => {
    held.push(route);
  });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto("/");

  await expect(page.locator(".tree.skeleton")).toHaveCount(0);
  const icons = page.locator("button.source img.node-icon");
  await expect(icons).toHaveCount(rowCount);
  await expect(page.locator("img.node-icon.skeleton-row")).toHaveCount(
    rowCount,
  );

  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all(
    held.map((route) =>
      route.fulfill({ body: pixel, contentType: "image/png" }),
    ),
  );
  await expect(page.locator("img.node-icon.skeleton-row")).toHaveCount(0);
});

test("fetches the tree once on a dashboard load, and not on sign-in routes", async ({
  page,
}) => {
  await installApiFixture(page);
  const treeRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/tree")
      treeRequests.push(request.url());
  });

  await page.goto("/");
  await expect(sourceRow(page)).toBeVisible();
  expect(treeRequests).toHaveLength(1);

  treeRequests.length = 0;
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(treeRequests).toEqual([]);
});

test("sweeps the skeleton by transform, and not at all under reduced motion", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.route("**/api/tree", () => {});
  await page.goto("/");
  const bar = page.locator(".tree.skeleton .skeleton-text").first();
  await expect(bar).toBeVisible();

  const sweep = () =>
    bar.evaluate((element) => ({
      bar: getComputedStyle(element).animationName,
      overlay: getComputedStyle(element, "::after").animationName,
    }));
  const moving = await sweep();
  expect(moving.bar).toBe("none");
  expect(moving.overlay).not.toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await sweep()).toEqual({ bar: "none", overlay: "none" });
});

test("offers first-run guidance while the tree is empty", async ({ page }) => {
  await installApiFixture(page);
  await page.route("**/api/tree", (route) =>
    respond(route, treeResponse, { tree: [] }),
  );
  await page.goto("/");

  await expect(page.getByText("No feeds yet.")).toBeVisible();
  await page.getByRole("button", { name: "Add your first feed" }).click();
  await expect(
    page.getByRole("heading", { name: "Discover feed" }),
  ).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Import an OPML file" }).click();
  await expect(
    page.getByRole("heading", { name: "Import OPML" }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#import-opml");
});

test("right-aligns folder and source unread counts to the same edge", async ({
  page,
}) => {
  await openApp(page);

  const folderCount = page.locator(".source.folder .unread-count").first();
  const sourceCount = page
    .locator(".tree.nested .source .unread-count")
    .first();
  await expect(folderCount).toBeVisible();
  await expect(sourceCount).toBeVisible();

  const folderBox = (await folderCount.boundingBox())!;
  const sourceBox = (await sourceCount.boundingBox())!;
  expect(
    Math.abs(folderBox.x + folderBox.width - (sourceBox.x + sourceBox.width)),
  ).toBeLessThan(1);
});

test("surfaces folder creation failures without refreshing the tree", async ({
  page,
}) => {
  const state = await installApiFixture(page, { folderCreateFailure: true });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");
  await page.getByRole("button", { name: "add folder" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Saved");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create" })
    .click();

  await expect(page.getByRole("alert")).toContainText(
    "The FeedFathom server ran into a problem. Try again in a moment.",
  );
  expect(state.treeRequests).toBe(1);
});

test("creates a folder through the in-app prompt", async ({ page }) => {
  const state = await openApp(page);
  await page.getByRole("button", { name: "add folder" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("New folder");
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await dialog.getByRole("textbox").fill("Saved");
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => state.treeRequests).toBe(2);
});

test("cancelling the delete confirmation keeps the source", async ({
  page,
}) => {
  const state = await openApp(page);
  await selectSource(page);

  await page.getByRole("button", { name: "delete source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Delete "Tech News"?');
  await expect(dialog).toHaveAccessibleName('Delete "Tech News"?');
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(sourceRow(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "delete source" }),
  ).toBeFocused();
  expect(state.removedSourceIds).toEqual([]);
});

test("keeps folder state usable when localStorage throws", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("storage blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("storage blocked");
    };
  });
  await openApp(page);

  await expect(sourceRow(page)).toBeVisible();
  await page.locator(".chevron").first().click();
  await expect(sourceRow(page)).toBeHidden();
});

test("a collapsed folder stays collapsed across a reload", async ({ page }) => {
  await openApp(page);
  const source = sourceRow(page);
  await expect(source).toBeVisible();
  await page.locator(".chevron").first().click();
  await expect(source).toBeHidden();

  await page.reload();
  await expect(
    page.locator("button.source").filter({ hasText: "Reading" }),
  ).toBeVisible();
  await expect(source).toBeHidden();
});

test("preserves an unauthenticated deep link through login", async ({
  page,
}) => {
  await installApiFixture(page, { authenticated: false });
  const next = "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml";
  await page.goto(next);

  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe(next);
  (browserFailures.get(page) ?? []).length = 0;

  await page.getByLabel("Email").fill("reader@example.com");
  await page.getByLabel("Password").fill("password");
  await page.getByRole("button", { name: "Login" }).click();

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname + url.search;
    })
    .toBe(next);
  await expect(page.getByLabel("Title")).toHaveValue("Tech Preview");
  await expect(
    page.getByRole("heading", { name: "Preview article" }),
  ).toBeVisible();
});

test("hangs a folder's nested group off its own treeitem", async ({ page }) => {
  await openApp(page);

  const folder = page.locator(".source.folder").first();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  const owns = await folder.getAttribute("aria-owns");
  expect(owns).toBeTruthy();
  await expect(page.locator(`#${owns}`)).toHaveAttribute("role", "group");
});

test("narrows the tree to what matches, and says so when nothing does", async ({
  page,
}) => {
  await openApp(page);

  const filter = page.getByLabel("Filter feeds");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();

  await filter.fill("tech");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();

  await filter.fill("nothing matches this");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toHaveCount(
    0,
  );
  await expect(page.getByText("No feeds match that.")).toBeVisible();

  await filter.fill("");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();
});

test("searches across subscriptions and says when nothing matches", async ({
  page,
}) => {
  await openApp(page);

  const search = page.getByLabel("Search articles");
  await search.fill("subscribed");
  await search.press("Enter");

  await expect(
    page.getByRole("option", { name: /Subscribed article/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Show")).toHaveValue("all");

  await search.fill("nothing matches this");
  await search.press("Enter");
  await expect(page.getByText("No articles match that.")).toBeVisible();

  await search.fill("");
  await expect(page.getByText("Select a feed to read.")).toBeVisible();
});

const deferred = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
};

test("a late response to a cleared search leaves the list empty", async ({
  page,
}) => {
  await installApiFixture(page);
  const { released: searchReleased, release: releaseSearch } = deferred();
  await page.route("**/api/articles", async (route) => {
    const { query } = Value.Parse(
      articlesRequest,
      route.request().postDataJSON(),
    );
    if (!query) return route.fallback();
    await searchReleased;
    return route.fallback();
  });
  await page.goto("/");

  const search = page.getByLabel("Search articles");
  await search.fill("subscribed");
  await search.press("Enter");
  await search.fill("");
  await expect(page.getByText("Select a feed to read.")).toBeVisible();

  releaseSearch();
  await expect(page.getByText("Select a feed to read.")).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Articles" }).getByRole("option"),
  ).toHaveCount(0);
});

test("fetches the next article page after a delete empties the list", async ({
  page,
}) => {
  await installApiFixture(page);
  const cursors: (number | undefined)[] = [];
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = Value.Parse(articlesRequest, route.request().postDataJSON());
    cursors.push(body.cursor);
    const start = body.cursor === undefined ? 1 : articlePageSize + 1;
    const size = body.cursor === undefined ? articlePageSize : 3;
    await respond(
      route,
      articlesResponse,
      Array.from({ length: size }, (_, index) => pagedSummary(start + index)),
    );
  });
  await page.route("**/api/article?*", fulfillPagedArticle);
  await page.goto("/");
  await selectSource(page);

  const rows = page.locator(".article-list .article");
  await expect(rows).toHaveCount(articlePageSize);
  expect(cursors).toEqual([undefined]);

  await page.getByRole("button", { exact: true, name: "select all" }).click();
  await page.getByRole("button", { name: "delete articles" }).click();

  await expect(rows).toHaveCount(3);
  expect(cursors).toEqual([undefined, articlePageSize]);
});

test("moving the focus re-evaluates only the rows it leaves and enters", async ({
  page,
}) => {
  await installApiFixture(page);
  const pageSize = 500;
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = Value.Parse(articlesRequest, route.request().postDataJSON());
    await respond(
      route,
      articlesResponse,
      body.cursor === undefined
        ? Array.from({ length: pageSize }, (_, index) =>
            pagedSummary(index + 1),
          )
        : [],
    );
  });
  await page.route("**/api/article?*", fulfillPagedArticle);
  await page.goto("/");
  await selectSource(page);
  const rows = page.locator(".article-list .article");
  await expect(rows).toHaveCount(pageSize);
  const calls = await rows.first().evaluate((row) => {
    const has = Set.prototype.has;
    let count = 0;
    // oxlint-disable-next-line no-extend-native -- counted, then restored
    Set.prototype.has = function (this: Set<unknown>, value: unknown) {
      count += 1;
      return has.call(this, value);
    };
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "ArrowDown",
      }),
    );
    // oxlint-disable-next-line no-extend-native
    Set.prototype.has = has;
    return count;
  });
  await expect(rows.nth(1)).toBeFocused();
  expect(calls).toBeLessThan(pageSize / 10);
});

test("pages the Today view with the view, not its node uid", async ({
  page,
}) => {
  await installApiFixture(page);
  const bodies: { cursor?: number; sources: number[]; view?: string }[] = [];
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = Value.Parse(articlesRequest, route.request().postDataJSON());
    bodies.push(body);
    const start = body.cursor === undefined ? 1 : articlePageSize + 1;
    const size = body.cursor === undefined ? articlePageSize : 3;
    await respond(
      route,
      articlesResponse,
      Array.from({ length: size }, (_, index) => pagedSummary(start + index)),
    );
  });
  await page.route("**/api/article?*", fulfillPagedArticle);
  await page.goto("/");
  await selectSource(page, "Today");

  const rows = page.locator(".article-list .article");
  await expect(rows).toHaveCount(articlePageSize);

  await page.getByRole("button", { exact: true, name: "select all" }).click();
  await page.getByRole("button", { name: "delete articles" }).click();
  await expect(rows).toHaveCount(3);

  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toMatchObject({
    cursor: articlePageSize,
    sources: [],
    view: "today",
  });
});

test("marks an article read, moving it between the filters", async ({
  page,
}) => {
  const state = await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  const filter = page.getByRole("combobox", { name: "Show" });
  await articleOptions(page).first().click();
  await page.getByRole("button", { name: "Mark read" }).click();

  await expect(articleOptions(page)).toHaveCount(2);
  expect([...state.readArticleIds]).toEqual([11]);

  await filter.selectOption("read");
  await expect(articleOptions(page)).toHaveCount(1);
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);

  await filter.selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);

  await articleOptions(page).first().click();
  await page.getByRole("button", { name: "Mark unread" }).click();
  await expect(page.locator(".article-list .article.read")).toHaveCount(0);
  expect([...state.readArticleIds]).toEqual([]);

  await articleOptions(page).first().click();
  await page.keyboard.press("m");
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);
  expect([...state.readArticleIds]).toEqual([11]);

  expect(state.articleRequests).toBe(3);
});

test("announces mark-read and delete results once per action", async ({
  page,
}) => {
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);
  const status = page.locator(".dashboard > [role='status']");
  await expect(status).toHaveAttribute("aria-live", "polite");

  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);
  await page.getByRole("button", { exact: true, name: "select all" }).click();
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(status).toHaveText("3 articles marked read.");

  await articleOptions(page).first().click();
  await page.getByRole("button", { name: "delete articles" }).click();
  await expect(status).toHaveText("Article deleted.");
  await expect(articleOptions(page)).toHaveCount(2);
  await articleOptions(page).first().click();
  const cleared = status.evaluate(
    (region) =>
      new Promise<boolean>((resolve) => {
        new MutationObserver(() => {
          if (region.textContent === "") resolve(true);
        }).observe(region, {
          characterData: true,
          childList: true,
          subtree: true,
        });
      }),
  );
  await page.getByRole("button", { name: "delete articles" }).click();
  expect(await cleared).toBe(true);
  await expect(status).toHaveText("Article deleted.");
});

test("scroll-past policy batches dwelled rows into one PATCH", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.setItem("markReadPolicy", "on-scroll-past");
  });
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.setViewportSize({ height: 320, width: 1280 });
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page)
    .last()
    .evaluate((row) => row.scrollIntoView());
  await intersectionsDelivered(page);
  await page.clock.runFor(10_000);
  await expect.poll(() => state.readMarks).toEqual([[12, 13]]);

  await expect(page.locator(".article-list .article.read")).toHaveCount(2);
  expect([...state.readArticleIds].toSorted((a, b) => a - b)).toEqual([12, 13]);
});

test("default policy never marks read on scroll", async ({ page }) => {
  await page.clock.install();
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.setViewportSize({ height: 320, width: 1280 });
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page)
    .last()
    .evaluate((row) => row.scrollIntoView());
  await intersectionsDelivered(page);
  await page.clock.runFor(10_000);

  await expect(page.locator(".article-list .article.read")).toHaveCount(0);
  expect(state.readMarks).toEqual([]);
  expect(state.readArticleIds.size).toBe(0);
});

test("the options page offers and persists the read-mark policy", async ({
  page,
}) => {
  await openApp(page, {}, "/options");

  const policy = page.getByRole("combobox", {
    name: "Mark articles read",
  });
  await expect(policy).toHaveValue("manual");
  await expect(policy.locator("option")).toHaveCount(3);
  await expect(policy.locator("option[value=manual]")).toHaveText(
    /Manually \(M key or Mark read\)/,
  );
  await expect(policy.locator("option[value=on-open]")).toHaveText(/On open/);
  await expect(policy.locator("option[value=on-scroll-past]")).toHaveText(
    /scroll-past/,
  );

  await policy.selectOption("on-scroll-past");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Mark articles read" }),
  ).toHaveValue("on-scroll-past");
});

test("scrolls the options page when the settings exceed the viewport", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.setViewportSize({ height: 500, width: 800 });
  await page.goto("/options");
  await expect(page.getByRole("heading", { name: "Options" })).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      ),
    )
    .toBeGreaterThan(0);
  expect(
    await page
      .locator(".options-page")
      .evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBe(0);

  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflowY),
  ).toBe("visible");
  expect(
    await page.evaluate(
      () => document.body.scrollHeight - document.body.clientHeight,
    ),
  ).toBe(0);

  await page.mouse.move(400, 250);
  await page.mouse.wheel(0, 600);
  await expect
    .poll(async () => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);

  await page.mouse.wheel(0, 5000);
  const lastCard = page.locator(".options-card").last();
  await expect(lastCard).toBeVisible();
  await expect
    .poll(async () =>
      lastCard.evaluate((el) => el.getBoundingClientRect().bottom),
    )
    .toBeLessThanOrEqual(500);
});

test("lists active sessions and signs out another one", async ({ page }) => {
  const state = await openApp(page, {}, "/options");
  await page.getByRole("link", { exact: true, name: "Account" }).click();
  await expect(page.getByText("This browser")).toBeVisible();
  await expect(page.getByText("This session")).toBeVisible();
  await expect(page.getByText("Phone")).toBeVisible();

  const currentRow = page
    .locator(".session-row")
    .filter({ hasText: "This browser" });
  await expect(currentRow.getByRole("button")).toHaveCount(0);

  await page
    .locator(".session-row")
    .filter({ hasText: "Phone" })
    .getByRole("button", { exact: true, name: "Sign out" })
    .click();
  await expect.poll(() => state.revokedSessionIds).toEqual([2]);
  await expect(page.getByText("Phone")).toHaveCount(0);
});

test("an expired session on the options page routes to login, returning to options", async ({
  page,
}) => {
  const state = await openApp(page, {}, "/options");
  await page.getByRole("link", { exact: true, name: "Account" }).click();
  await expect(page.getByText("Phone")).toBeVisible();

  state.authenticated = false;
  await page
    .getByRole("button", { name: "Sign out all other sessions" })
    .click();

  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe("/options");
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 401 (Unauthorized)",
  ]);
  failures.length = 0;
});

test("signs out all other sessions at once", async ({ page }) => {
  const state = await openApp(page, {}, "/options");
  await page.getByRole("link", { exact: true, name: "Account" }).click();
  await expect(page.getByText("This browser")).toBeVisible();

  await page
    .getByRole("button", { name: "Sign out all other sessions" })
    .click();
  await expect.poll(() => state.revokedOtherSessions).toBe(true);
  await expect(page.getByText("Phone")).toHaveCount(0);
  await expect(page.getByText("This browser")).toBeVisible();
});

test("a password change keeps this session and drops the others from the list", async ({
  page,
}) => {
  await openApp(page, {}, "/options");
  await page.getByRole("link", { exact: true, name: "Account" }).click();
  await expect(page.getByText("Phone")).toBeVisible();

  await page.getByLabel("Current password").fill("old-password");
  await page.getByLabel("New password", { exact: true }).fill("new-password");
  await page.getByLabel("Confirm new password").fill("new-password");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByRole("status")).toHaveText("Password changed.");
  await expect(page.getByText("Phone")).toHaveCount(0);
  await expect(page.getByText("This browser")).toBeVisible();
});

test("a throttled password change says to try again later", async ({
  page,
}) => {
  await openApp(page, {}, "/options");
  await page.route("**/api/options/password", (route) =>
    refuse(route, 429, "Too many attempts. Try again later."),
  );
  await page.getByRole("link", { exact: true, name: "Account" }).click();

  await page.getByLabel("Current password").fill("old-password");
  await page.getByLabel("New password", { exact: true }).fill("new-password");
  await page.getByLabel("Confirm new password").fill("new-password");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Too many attempts. Try again later.",
  );
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
  ]);
  failures.length = 0;
});

const openRegistration = async (
  page: Page,
  answer: (route: Route) => Promise<void>,
) => {
  await installApiFixture(page, { authenticated: false });
  await page.route("**/api/register", (route) =>
    route.request().method() === "GET"
      ? respond(route, registrationResponse, {
          passwordResetEnabled: true,
          registrationStatus: "ENABLED",
          turnstileSiteKey: null,
        })
      : answer(route),
  );
  await page.goto("/register");
  await page.getByLabel("Name").fill("Reader");
  await page.getByLabel("Email").fill("reader@example.com");
  await page.getByLabel("Password", { exact: true }).fill("password");
  await page.getByLabel("Confirm password").fill("password");
  await page.getByRole("button", { name: "Register" }).click();
};

test("registration success says what to do if no email arrives", async ({
  page,
}) => {
  await openRegistration(page, (route) =>
    respond(route, successResponse, { success: true }),
  );

  await expect(
    page.getByRole("heading", { name: "Registration successful" }),
  ).toBeVisible();
  await expect(
    page.getByText("register again with the same address"),
  ).toBeVisible();
});

test("a throttled registration says to try again later", async ({ page }) => {
  await openRegistration(page, (route) =>
    refuse(route, 429, "Too many attempts. Try again later."),
  );

  await expect(page.getByRole("alert")).toHaveText(
    "Too many attempts. Try again later.",
  );
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
  ]);
  failures.length = 0;
});

test("the reader steps change the rendered column, not just storage", async ({
  page,
}) => {
  await openApp(page);
  await selectSource(page);
  await expect(page.locator(".reader h1")).toBeVisible();

  const reader = page.locator(".reader");
  const columnOf = () =>
    reader.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        inlinePadding: Number.parseFloat(style.paddingLeft),
      };
    });

  const medium = await columnOf();

  await page.goto("/options#appearance");
  const size = page.getByRole("combobox", { name: "Text size" });
  await expect(size).toHaveValue("medium");
  await expect(page.getByRole("combobox", { name: "Line width" })).toHaveValue(
    "medium",
  );
  await size.selectOption("large");
  await page.goto("/");
  await selectSource(page);
  await expect(page.locator(".reader h1")).toBeVisible();
  const large = await columnOf();
  expect(large.fontSize).toBeGreaterThan(medium.fontSize);

  await page.goto("/options#appearance");
  await page
    .getByRole("combobox", { name: "Line width" })
    .selectOption("small");
  await page.goto("/");
  await selectSource(page);
  await expect(page.locator(".reader h1")).toBeVisible();
  const narrow = await columnOf();
  expect(narrow.inlinePadding).toBeGreaterThan(large.inlinePadding);
});

test("compact density tightens the tree without touching the theme", async ({
  page,
}) => {
  await openApp(page);
  const row = page.locator(".source.folder").first();
  await expect(row).toBeVisible();
  const comfortable = (await row.boundingBox())!.height;

  await page.goto("/options#appearance");
  const density = page.getByRole("combobox", { name: "Density" });
  await expect(density).toHaveValue("comfortable");
  await density.selectOption("compact");
  await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue(
    "auto",
  );
  await page.goto("/");
  await expect(row).toBeVisible();
  const compact = (await row.boundingBox())!.height;
  expect(comfortable).toBe(28);
  expect(compact).toBe(20);
});

test("tells read from unread by weight, not only colour", async ({ page }) => {
  await openApp(page, { multipleArticles: true });
  await selectSource(page);

  const weightOf = (index: number) =>
    articleOptions(page)
      .nth(index)
      .locator(".title")
      .evaluate((title) => getComputedStyle(title).fontWeight);

  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);
  const unreadWeight = await weightOf(0);

  await articleOptions(page).first().click();
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);

  await expect(articleOptions(page).first()).toHaveClass(/selected/);
  const readWeight = await weightOf(0);
  expect(readWeight).not.toBe(unreadWeight);
  expect(Number(unreadWeight)).toBeGreaterThan(Number(readWeight));
});

test("keeps exactly one tree tab stop across filtering", async ({ page }) => {
  await openApp(page);
  const tabStops = page.locator('[role="treeitem"][tabindex="0"]');
  await expect(tabStops).toHaveCount(1);

  await page.getByLabel("Filter feeds").fill("tech");
  await expect(tabStops).toHaveCount(1);

  await page.getByLabel("Filter feeds").fill("");
  await expect(tabStops).toHaveCount(1);
});

test("tree arrows stop at the ends and Home and End jump to them", async ({
  page,
}) => {
  await openApp(page);
  const rows = page.locator(".sources-pane .source");
  await page.locator('[role="treeitem"][tabindex="0"]').focus();
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.last()).toBeFocused();

  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
});

test("moving tree focus works out the tab stop once, not per row", async ({
  page,
}) => {
  await installApiFixture(page);
  const rowCount = 300;
  await page.route("**/api/tree", (route) =>
    respond(route, treeResponse, {
      tree: Array.from({ length: rowCount }, (_, index): TreeNode => ({
        favicon: null,
        homeUrl: "https://news.example/",
        kind: "feed",
        name: `Feed ${index}`,
        type: "source",
        uid: String(index + 1),
        unreadCount: 0,
        xmlUrl: `https://news.example/${index}.xml`,
      })),
    }),
  );
  await page.goto("/");
  const rows = page.locator('[role="treeitem"]');
  await expect(rows).toHaveCount(rowCount + 1);
  const calls = await rows.nth(1).evaluate((row) => {
    const some = Array.prototype.some;
    let count = 0;
    // oxlint-disable-next-line no-extend-native -- counted, then restored
    Array.prototype.some = function <T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => unknown,
    ) {
      count += 1;
      return some.call(this, predicate);
    };
    if (row instanceof HTMLElement) row.focus();
    // oxlint-disable-next-line no-extend-native
    Array.prototype.some = some;
    return count;
  });
  await expect(rows.nth(1)).toBeFocused();
  expect(calls).toBeLessThan(rowCount / 10);
});

test("a tree poll updates rows in place and keeps focus", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  const row = sourceRow(page);
  await expect(row.locator(".unread-count")).toHaveText("2");
  await row.focus();
  const folder = await page.locator("button.source.folder").elementHandle();
  const source = await row.elementHandle();

  await page.route("**/api/tree", (route) =>
    respond(route, treeResponse, {
      tree: [
        {
          children: [
            {
              favicon: null,
              homeUrl: "https://news.example/",
              kind: "feed",
              name: "Tech News",
              type: "source",
              uid: "3",
              unreadCount: 5,
              xmlUrl: "https://news.example/feed.xml",
            },
          ],
          name: "Reading",
          type: "folder",
          uid: "7",
        },
      ],
    }),
  );
  await page.clock.runFor(30_000);
  await expect(row.locator(".unread-count")).toHaveText("5");

  expect(await folder?.evaluate((node) => node.isConnected)).toBe(true);
  expect(
    await source?.evaluate((node) => node === document.activeElement),
  ).toBe(true);
});

test("offers a password reset link only where mail can deliver one", async ({
  page,
}) => {
  await openApp(page, { authenticated: false }, "/login");
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Forgot your password?" }),
  ).toHaveCount(0);

  await installApiFixture(page, {
    authenticated: false,
    passwordResetEnabled: true,
  });
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();

  await expect(
    page.getByRole("heading", { name: "Reset your password" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/password-reset");
});

test("opening the activation link activates nothing until the button says so", async ({
  page,
}) => {
  await installApiFixture(page, { authenticated: false });
  const activations: string[] = [];
  await page.route("**/api/activate/**", async (route) => {
    activations.push(route.request().method());
    return respond(route, successResponse, { success: true });
  });

  await page.goto("/activate/scan-magnet");
  await expect(
    page.getByRole("heading", { name: "Account activation" }),
  ).toBeVisible();
  expect(activations).toEqual([]);

  await page.getByRole("button", { name: "Activate account" }).click();
  await expect(
    page.getByText("Your account has been activated."),
  ).toBeVisible();
  expect(activations).toEqual(["POST"]);
});

test("hides the tab-title unread count when the setting is Hide", async ({
  page,
}) => {
  await openApp(page);
  await expect(page).toHaveTitle("(2) FeedFathom");

  await page.getByRole("button", { name: "options" }).first().click();
  await expect(page).toHaveTitle("Options · FeedFathom");
  await page.getByRole("link", { name: "Lists" }).click();
  await page
    .getByRole("checkbox", { name: "Show the unread count in the tab title" })
    .uncheck();
  await expect(page).toHaveTitle("Options · FeedFathom");

  await page.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveTitle("FeedFathom");

  await page.reload();
  await expect(page).toHaveTitle("FeedFathom");
});

test("the pre-#714 markReadOnOpen boolean becomes the on-open policy", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("markReadOnOpen", "true"),
  );
  await openApp(page, {}, "/options");
  await expect(
    page.getByRole("combobox", { name: "Mark articles read" }),
  ).toHaveValue("on-open");
});

test("hides the feed filter and article search boxes independently", async ({
  page,
}) => {
  await openApp(page);
  await page.getByLabel("Filter feeds").fill("nothing matches this");
  await expect(page.getByText("No feeds match that.")).toBeVisible();

  await page.getByRole("button", { name: "options" }).first().click();
  await page.getByRole("link", { name: "Lists" }).click();
  await page
    .getByRole("checkbox", { name: "Show the feed filter box" })
    .uncheck();
  await page.getByRole("link", { name: "Home" }).click();

  await expect(page.getByLabel("Filter feeds")).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();
  await expect(page.getByLabel("Search articles")).toBeVisible();

  await page.getByRole("button", { name: "options" }).first().click();
  await page.getByRole("link", { name: "Lists" }).click();
  await page
    .getByRole("checkbox", { name: "Show the article search box" })
    .uncheck();
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByLabel("Search articles")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();
  await expect(page.getByLabel("Filter feeds")).toHaveCount(0);
  await expect(page.getByLabel("Search articles")).toHaveCount(0);
});

const recordArticleRequests = (page: Page) =>
  page.addInitScript(() => {
    const fetchPage = window.fetch.bind(window);
    Object.defineProperty(window, "fetch", {
      value: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          location.href,
        );
        if (url.pathname === "/api/article")
          sessionStorage.setItem(
            "articleRequests",
            `${sessionStorage.getItem("articleRequests") ?? ""} ${url.searchParams.get("article")}`,
          );
        return fetchPage(input, init);
      },
    });
  });

const recordedArticleRequests = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) =>
        requestIdleCallback(() =>
          resolve(
            (sessionStorage.getItem("articleRequests") ?? "")
              .split(" ")
              .filter(Boolean),
          ),
        ),
      ),
  );

const requestedArticleIds = (page: Page) => {
  const ids: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/article")
      ids.push(url.searchParams.get("article") ?? "");
  });
  return ids;
};

test("prefetches the next article when the setting is On", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prefetchNext", "on");
  });
  await installApiFixture(page, { multipleArticles: true });
  const ids = requestedArticleIds(page);
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page).first().click();
  await expect.poll(() => new Set(ids).size).toBeGreaterThan(1);
});

test("skips the next-article prefetch when the setting is Off", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("prefetchNext", "off");
  });
  await recordArticleRequests(page);
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page).first().click();
  await expect(page.locator(".reader")).toContainText("Feed article content");
  const requested = await recordedArticleRequests(page);
  expect(new Set(requested).size).toBe(1);
  expect(["11", "12", "13"]).toContain(requested[0]);
});

test("skips the next-article prefetch under Save Data", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prefetchNext", "true");
    Object.defineProperty(navigator, "connection", {
      value: { saveData: true },
    });
  });
  await recordArticleRequests(page);
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await expect(page.locator(".reader")).toContainText("Feed article content");
  expect(new Set(await recordedArticleRequests(page))).toEqual(new Set(["11"]));
});

test("a press starts the article fetch even with prefetch Off", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("prefetchNext", "off");
  });
  await recordArticleRequests(page);
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await expect(page.locator(".reader")).toContainText("Feed article content");
  const before = (await recordedArticleRequests(page)).length;
  await articleOptions(page)
    .last()
    .dispatchEvent("pointerdown", { button: 0, pointerType: "mouse" });
  expect(await recordedArticleRequests(page)).toHaveLength(before + 1);
  await articleOptions(page)
    .nth(1)
    .dispatchEvent("pointerdown", { button: 2, pointerType: "mouse" });
  expect(await recordedArticleRequests(page)).toHaveLength(before + 1);
});

test("shows the current account and logs out", async ({ page }) => {
  const state = await openApp(page, {}, "/options");
  await page.getByRole("link", { exact: true, name: "Account" }).click();

  await expect(page.getByText("Reader (reader@example.com)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  expect(state.authenticated).toBe(false);
});

test("surfaces a malformed Options session without crashing", async ({
  page,
}) => {
  await openApp(page, { sessionFailure: true }, "/options");

  await expect(page.getByRole("alert")).toContainText(
    "The FeedFathom server ran into a problem. Try again in a moment.",
  );
  expect(new URL(page.url()).pathname).toBe("/options");
});

test("loads articles and content from a selected source", async ({ page }) => {
  await openApp(page);
  const deleteButton = page.getByRole("button", { name: "delete articles" });
  await expect(deleteButton).toBeDisabled();
  await selectSource(page);
  await expect(deleteButton).toBeEnabled();

  const option = page.getByRole("option", { name: /First article/ });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "First article" }),
  ).toBeVisible();
  await expect(page.getByText("Feed article content")).toBeVisible();
});

test("select all preserves scroll and moves focus so Delete works immediately", async ({
  page,
}) => {
  const state = await openApp(page, { multipleArticles: true });
  await page.addStyleTag({ content: ".article-list { max-height: 40px; }" });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  const list = page.locator(".article-list");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const scrolledTop = await list.evaluate((element) => element.scrollTop);
  expect(scrolledTop).toBeGreaterThan(0);

  await page.getByRole("button", { name: "select all" }).click();
  await expect(list).toHaveJSProperty("scrollTop", scrolledTop);
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: /Second article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: /Third article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(":focus")).toHaveAttribute("role", "option");

  await page.keyboard.press("Delete");
  await expect(articleOptions(page)).toHaveCount(0);
  await expect
    .poll(() => state.removedArticleIds.toSorted((a, b) => a - b))
    .toEqual([11, 12, 13]);
});

test("selecting a single article then pressing Delete removes only it", async ({
  page,
}) => {
  const state = await openApp(page, { multipleArticles: true });
  await selectSource(page);

  await page.getByRole("option", { name: /Second article/ }).click();
  await page.keyboard.press("Delete");

  await expect(articleOptions(page)).toHaveCount(2);
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Third article/ }),
  ).toBeVisible();
  expect(state.removedArticleIds).toEqual([12]);
});

test("each article delete names the input that triggered it", async ({
  page,
}) => {
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await page.getByRole("option", { name: /First article/ }).click();

  const traceOf = async (action: () => Promise<void>) => {
    const request = page.waitForRequest(
      (candidate) =>
        candidate.method() === "DELETE" &&
        new URL(candidate.url()).pathname === "/api/articles",
    );
    await action();
    return JSON.parse(
      (await request).headers()["x-feedfathom-trace"] ?? "null",
    );
  };

  const clicked = await traceOf(() =>
    page.getByRole("button", { name: "delete articles" }).click(),
  );
  expect(clicked.trigger).toMatchObject({
    target: "button[delete articles]",
    trusted: true,
    type: "click",
  });
  expect(clicked.sinceLastDeleteMs).toBeNull();

  const pressed = await traceOf(() => page.keyboard.press("Delete"));
  expect(pressed.trigger).toMatchObject({
    key: "Delete",
    repeat: false,
    trusted: true,
    type: "keydown",
  });
  expect(pressed.sinceLastDeleteMs).toBeGreaterThan(0);
  expect(pressed.recent.map((entry: { type: string }) => entry.type)).toContain(
    "click",
  );
});

test("source properties reuses the discovery panel with feed/website locked", async ({
  page,
}) => {
  await openApp(page);
  await selectSource(page);

  await page.getByRole("button", { name: "source properties" }).click();

  await expect(page.getByRole("heading", { name: "Edit feed" })).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("Tech News");
  const website = page.getByLabel("Website");
  const feedUrl = page.getByLabel("Feed URL");
  await expect(website).toHaveValue("https://news.example/");
  await expect(website).not.toBeEditable();
  await expect(website).toBeEnabled();
  await expect(feedUrl).toHaveValue("https://news.example/feed.xml");
  await expect(feedUrl).not.toBeEditable();
  await expect(feedUrl).toBeEnabled();
  await expect(page.getByRole("button", { name: "Find feeds" })).toHaveCount(0);
});

test("the discovery panel takes focus on open and Escape hands it back", async ({
  page,
}) => {
  await openApp(page);

  const add = page.getByRole("button", { name: "add source" });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Website")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Discover feed" }),
  ).toHaveCount(0);
  await expect(add).toBeFocused();

  await selectSource(page);
  await page.getByRole("button", { name: "source properties" }).click();
  await expect(page.getByLabel("Title")).toBeFocused();
});

test("renaming a source through the edit panel updates the tree", async ({
  page,
}) => {
  const state = await openApp(page);
  await selectSource(page);
  await page.getByRole("button", { name: "source properties" }).click();

  await page.getByLabel("Title").fill("Renamed Feed");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(
    page.locator("button.source").filter({ hasText: "Renamed Feed" }),
  ).toBeVisible();
  expect(state.updatedSource).toEqual({ name: "Renamed Feed", parentId: 7 });
});

test("cancelling the edit panel discards changes", async ({ page }) => {
  const state = await openApp(page);
  await selectSource(page);
  await page.getByRole("button", { name: "source properties" }).click();

  await page.getByLabel("Title").fill("Should not save");
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("heading", { name: "Edit feed" })).toHaveCount(0);
  await expect(sourceRow(page)).toBeVisible();
  expect(state.updatedSource).toBeUndefined();
});

test("deletes a source after confirmation and refreshes the tree", async ({
  page,
}) => {
  const state = await openApp(page);
  await selectSource(page);

  await page.getByRole("button", { name: "delete source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(sourceRow(page)).toHaveCount(0);
  expect(state.removedSourceIds).toEqual([3]);
});

test("renaming a folder through properties updates the tree", async ({
  page,
}) => {
  const state = await openApp(page);
  await page
    .locator("button.source.folder")
    .filter({ hasText: "Reading" })
    .click();

  await page.getByRole("button", { name: "source properties" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveValue("Reading");
  await dialog.getByRole("textbox").fill("Archive");
  await dialog.getByRole("button", { name: "Rename" }).click();

  await expect(
    page.locator("button.source.folder").filter({ hasText: "Archive" }),
  ).toBeVisible();
  expect(state.updatedFolder).toEqual({ name: "Archive" });
});

test("an empty folder offers Add feed, which starts Discover in it", async ({
  page,
}) => {
  await openApp(page, { emptyFolder: true });
  await page.locator("button.source").filter({ hasText: "Later" }).click();
  await expect(page.getByText("This folder is empty.")).toBeVisible();
  await expect(page.getByLabel("Search articles")).toBeDisabled();
  await page.getByRole("button", { name: "Add feed" }).click();
  await expect(page.getByLabel("Folder")).toHaveValue("12");
});

test("blocks deleting a non-empty folder", async ({ page }) => {
  await openApp(page);
  await page
    .locator("button.source.folder")
    .filter({ hasText: "Reading" })
    .click();

  await page.getByRole("button", { name: "delete source" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Folder is not empty");
  await expect(sourceRow(page)).toBeVisible();
});

test("shows the generic RSS icon for a source with no favicon", async ({
  page,
}) => {
  await openApp(page);

  const nodeIcon = sourceRow(page).locator(".node-icon");
  await expect(nodeIcon.locator("svg")).toBeVisible();
  await expect(nodeIcon.locator("img")).toHaveCount(0);
});

test("uses three desktop panes and mobile history navigation", async ({
  page,
}) => {
  await openApp(page);

  await expect(page.locator(".sources-pane")).toBeVisible();
  await expect(page.locator(".articles-pane")).toBeVisible();
  await expect(page.locator(".reader-pane")).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.locator(".sources-pane")).toBeVisible();
  await expect(page.locator(".articles-pane")).toBeHidden();
  await expect(page.locator(".reader-pane")).toBeHidden();

  await selectSource(page);
  await expect(page.locator(".sources-pane")).toBeHidden();
  await expect(page.locator(".articles-pane")).toBeVisible();

  await page.getByRole("option", { name: /First article/ }).click();
  await expect(page.locator(".articles-pane")).toBeHidden();
  await expect(page.locator(".reader-pane")).toBeVisible();

  await page
    .locator(".reader-pane")
    .getByRole("button", { name: "back" })
    .click();
  await expect(page.locator(".articles-pane")).toBeVisible();
  await page
    .locator(".articles-pane")
    .getByRole("button", { name: "back" })
    .click();
  await expect(page.locator(".sources-pane")).toBeVisible();
});

test("Back closes Discover onto the feeds, not the page before", async ({
  page,
}) => {
  await openApp(page);
  await page.setViewportSize({ height: 844, width: 390 });
  const entries = () => page.evaluate(() => history.length);
  const discover = page.getByRole("heading", { name: "Discover feed" });

  const before = await entries();
  await page.getByRole("button", { name: "options" }).first().click();
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.locator(".sources-pane")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.goForward();
  await expect(page).toHaveURL(/\/options$/);
  await page.goBack();
  expect(await entries()).toBe(before + 1);

  await page.getByRole("button", { name: "add source" }).click();
  await expect(discover).toBeVisible();
  await page.goBack();
  await expect(discover).toHaveCount(0);
  await expect(page.locator(".sources-pane")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");

  await page.getByRole("button", { name: "add source" }).click();
  await page.getByRole("button", { name: "back" }).click();
  await expect(discover).toHaveCount(0);
  await page.goForward();
  await expect(discover).toBeVisible();
  await page.reload();
  await expect(page.locator(".sources-pane")).toBeVisible();
  await expect(discover).toHaveCount(0);

  await page.goto("/options");
  await page.getByRole("link", { name: "Home" }).click();
  await selectSource(page);
  await page
    .locator(".articles-pane")
    .getByRole("button", { name: "options" })
    .click();
  await expect(page).toHaveURL(/\/options$/);
});

test("cross-fades mobile pane switches unless motion is reduced", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);
    Object.assign(window, { viewTransitions: 0 });
    document.startViewTransition = (update) => {
      Object.assign(window, {
        viewTransitions: Number(Reflect.get(window, "viewTransitions")) + 1,
      });
      return start(update);
    };
  });
  const transitions = () =>
    page.evaluate(() => Number(Reflect.get(window, "viewTransitions")));
  await openApp(page);

  await selectSource(page);
  await expect(page.locator(".articles-pane")).toBeVisible();
  expect(await transitions()).toBe(0);

  await page.setViewportSize({ height: 844, width: 390 });
  await page.getByRole("option", { name: /First article/ }).click();
  await expect(page.locator(".reader-pane")).toBeVisible();
  await expect(page.locator(".articles-pane")).toBeHidden();
  expect(await transitions()).toBe(1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .locator(".reader-pane")
    .getByRole("button", { name: "back" })
    .click();
  await expect(page.locator(".articles-pane")).toBeVisible();
  expect(await transitions()).toBe(1);
});

test("a double tap on a feed leaves one history entry to go back", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");

  await sourceRow(page).evaluate((button) => {
    if (!(button instanceof HTMLElement)) return;
    button.click();
    button.click();
  });
  await expect(page.locator(".articles-pane")).toBeVisible();
  await page
    .locator(".articles-pane")
    .getByRole("button", { name: "back" })
    .click();
  await expect(page.locator(".sources-pane")).toBeVisible();
});

for (const theme of ["smart", "high-contrast"]) {
  test(`off-screen article rows keep a rendered row's height (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await installApiFixture(page, { manyArticles: true });
    await page.setViewportSize({ height: 600, width: 1280 });
    await page.goto("/");
    await selectSource(page);
    await expect(articleOptions(page)).toHaveCount(60);
    await articleOptions(page)
      .nth(1)
      .evaluate((row) => {
        for (const text of row.querySelectorAll(".title, .details > *"))
          text.textContent = "";
      });

    const rows = await page
      .locator(".article-list .article")
      .evaluateAll((elements) =>
        elements.map((row) => ({
          height: row.getBoundingClientRect().height,
          rendered:
            row.firstElementChild?.checkVisibility({
              contentVisibilityAuto: true,
            }) ?? false,
        })),
      );
    expect(rows[0]?.rendered).toBe(true);
    expect(rows.at(-1)?.rendered).toBe(false);
    expect(new Set(rows.map((row) => row.height)).size).toBe(1);
  });
}

test("mints a newsletter address when opened with ?newsletter", async ({
  page,
}) => {
  const state = await openApp(
    page,
    { mailDomain: "mail.example" },
    "/preview?newsletter",
  );

  const feedUrl = page.getByLabel("Email address");
  await expect(feedUrl).toHaveValue(/^[\da-f]{16}@mail\.example$/u);
  const minted = await feedUrl.inputValue();
  await expect.poll(() => state.reservedAddresses).toEqual([minted]);
  await expect(page).toHaveURL(
    `/preview?feedUrl=${encodeURIComponent(minted)}`,
  );
  await page.reload();
  await expect(feedUrl).toHaveValue(minted);
  await expect.poll(() => state.reservedAddresses).toEqual([minted, minted]);
});

test("says so when a generated address could not be reserved", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = await openApp(page, { mailDomain: "mail.example" }, "/preview");
  state.failReservations = true;

  await page.getByRole("button", { name: "Generate email address" }).click();
  await expect(
    page.getByText(
      "Address not reserved: mail sent to it bounces until you subscribe. Generate another or subscribe now.",
    ),
  ).toBeVisible();
  const address = await page.getByLabel("Email address").inputValue();
  expect(state.deliverNewsletter(address)).toBe(false);

  state.failReservations = false;
  await page.reload();
  await expect(page.getByLabel("Email address")).toHaveValue(address);
  await expect.poll(() => state.deliverNewsletter(address)).toBe(true);
  await expect(page.getByText(/^Address not reserved/u)).toHaveCount(0);
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
  ]);
  failures.length = 0;
});

test("keeps mail sent to a generated address before Subscribe", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = await openApp(page, { mailDomain: "mail.example" }, "/preview");

  await page.getByRole("button", { name: "Generate email address" }).click();
  await expect(page.getByText("Address copied.")).toBeVisible();
  const address = await page.getByLabel("Email address").inputValue();
  await expect.poll(() => state.deliverNewsletter(address)).toBe(true);

  await page.getByLabel("Title").fill("Letters");
  await page.getByRole("button", { name: "Subscribe" }).click();

  await expect(
    page.getByRole("heading", { name: "Confirm your subscription" }),
  ).toBeVisible();
  expect(state.subscriptionBodies).toEqual([
    { sourceFolder: null, sourceName: "Letters", sourceUrl: address },
  ]);
});

test("explains a refused address instead of the server's error", async ({
  page,
}) => {
  await openApp(page, { mailDomain: "mail.example" }, "/preview");

  await page.getByLabel("Feed URL").fill("me@mail.example");
  await page.getByLabel("Title").fill("Letters");
  await page.getByRole("button", { name: "Subscribe" }).click();

  await expect(
    page.getByText(
      "Could not subscribe: not a valid feed URL or a newsletter address generated here.",
    ),
  ).toBeVisible();
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)",
  ]);
  failures.length = 0;
});

test("validates Website URLs before discovery", async ({ page }) => {
  const state = await openApp(page, {}, "/preview");
  const website = page.getByLabel("Website");

  await website.fill("ftp://preview.example/");
  await page.getByRole("button", { name: "Find feeds" }).click();
  expect(state.findRequests).toBe(0);
  expect(
    await website.evaluate(
      (input) => input instanceof HTMLInputElement && input.validity.valid,
    ),
  ).toBe(false);

  await website.fill("https://preview.example/");
  await page.getByRole("button", { name: "Find feeds" }).click();
  await expect(
    page.getByRole("button", { name: /Tech Preview/ }),
  ).toBeVisible();
  expect(state.findRequests).toBe(1);
});

test("marks a found feed that advertises WebSub, and only that one", async ({
  page,
}) => {
  await openApp(page, { websubFeed: true }, "/preview");
  await page.getByLabel("Website").fill("https://preview.example/");
  await page.getByRole("button", { name: "Find feeds" }).click();

  const result = page
    .getByRole("button", { name: /Tech Preview/ })
    .locator(".websub-badge");
  await expect(result).toBeVisible();
  await expect(result).toHaveText("WebSub");
  await expect(page.locator(".websub-badge")).toHaveCount(1);
});

test("keeps the newest discovery preview response", async ({ page }) => {
  const state = await openApp(page, { discoveryRace: true }, "/preview");
  await page.getByLabel("Website").fill("https://preview.example/");
  await page.getByRole("button", { name: "Find feeds" }).click();

  const slowPreview = page.waitForRequest((request) =>
    request.url().includes("slow.xml"),
  );
  await page.getByRole("button", { name: /Slow feed/ }).click();
  await page.getByRole("button", { name: /Fast feed/ }).click();

  await expect(page.getByLabel("Title")).toHaveValue("Fast feed");
  state.releaseSlowPreview();
  await (await (await slowPreview).response())?.finished();
  await page.evaluate(
    () => new Promise((resolve) => requestIdleCallback(resolve)),
  );
  await expect(page.getByLabel("Title")).toHaveValue("Fast feed");
  await expect(
    page.getByRole("heading", { name: "Fast feed article" }),
  ).toBeVisible();
});

for (const admin of [false, true])
  test(`a failed preview gives ${admin ? "an admin" : "a reader"} ${admin ? "the sentence and its details" : "the sentence alone"}`, async ({
    page,
  }) => {
    await installApiFixture(page, { admin });
    await page.route("**/api/preview?*", (route) =>
      respond(
        route,
        errorResponse,
        {
          detail: "getaddrinfo ENOTFOUND preview.example",
          error: "This site can't be found.",
        },
        400,
      ),
    );
    await page.goto("/preview");
    await page.getByLabel("Feed URL").fill("https://preview.example/feed.xml");
    await page.getByRole("button", { name: "Load preview" }).click();
    await expect(page.locator("#feed-url-error")).toHaveText(
      "This site can't be found.",
    );
    (browserFailures.get(page) ?? []).length = 0;
    const details = page.locator(".failure-details");
    if (!admin) {
      await expect(details).toHaveCount(0);
      return;
    }
    await details.getByText("Details").click();
    await expect(details).toContainText(
      "HTTP 400. getaddrinfo ENOTFOUND preview.example",
    );
  });

test("keeps preview usable when folder startup fails", async ({ page }) => {
  await installApiFixture(page, { foldersFailure: true });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml");

  await expect(page.getByLabel("Title")).toHaveValue("Tech Preview");
  await expect(page.getByRole("alert")).toContainText(
    "The FeedFathom server ran into a problem. Try again in a moment.",
  );
});

test("previews and subscribes with the exact payload", async ({ page }) => {
  const state = await openApp(
    page,
    {},
    "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml",
  );

  await expect(page.getByLabel("Title")).toHaveValue("Tech Preview");
  await expect(page.getByLabel("Folder")).toContainText("Reading");
  await expect(
    page.getByRole("heading", { name: "Preview article" }),
  ).toBeVisible();
  await expect(
    page.getByText("This preview shows part of the feed."),
  ).toHaveCount(0);

  await page.getByLabel("Folder").selectOption("7");
  await page.getByRole("button", { name: "Subscribe" }).click();

  await expect(
    page.getByRole("heading", { name: "Subscribed article" }),
  ).toBeVisible();
  expect(state.subscriptionBodies).toEqual([
    {
      sourceFolder: 7,
      sourceName: "Tech Preview",
      sourceUrl: "https://preview.example/feed.xml",
    },
  ]);
  expect(state.treeRequests).toBe(2);
});

test("notes when a preview shows only part of the feed", async ({ page }) => {
  await openApp(
    page,
    { previewTruncated: true },
    "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml",
  );

  await expect(
    page.getByRole("heading", { name: "Preview article" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Preview articles" })
      .getByText(
        "This preview shows part of the feed. Subscribing imports all of it.",
      ),
  ).toBeVisible();
});

test("lists the discovery preview articles as a list", async ({ page }) => {
  await openApp(
    page,
    {},
    "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml",
  );

  const articles = page.getByRole("region", { name: "Preview articles" });
  await expect(articles.getByRole("list")).toHaveCount(1);
  await expect(articles.getByRole("listitem")).toHaveCount(1);
  await expect(
    articles.getByRole("listitem").getByRole("link", { name: /article/ }),
  ).toBeVisible();
});

test("a preview opens its first article and leaves modified clicks alone", async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.addEventListener("click", (event) => {
      sessionStorage.setItem("clickTaken", String(event.defaultPrevented));
      event.preventDefault();
    }),
  );
  await openApp(
    page,
    {},
    "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml",
  );
  const link = page
    .getByRole("region", { name: "Preview articles" })
    .getByRole("link", { name: /article/ });
  await expect(link).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("article", { name: "Preview reader" }),
  ).toContainText("Preview article content");

  const clickTaken = async (
    modifiers: ("Alt" | "ControlOrMeta" | "Shift")[],
  ) => {
    await link.click({ modifiers });
    return await page.evaluate(() => sessionStorage.getItem("clickTaken"));
  };
  expect(await clickTaken([])).toBe("true");
  expect(await clickTaken(["Alt"])).toBe("false");
  expect(await clickTaken(["ControlOrMeta"])).toBe("false");
  expect(await clickTaken(["Shift"])).toBe("false");
});

test("gives extracted images the app's own loading defaults", async ({
  context,
  page,
}) => {
  await installReaderResponder(context, true);
  await openApp(page);
  await selectSource(page);

  await page
    .getByRole("combobox", { name: "Article display mode" })
    .selectOption("READABILITY");
  const image = page.locator(".reader img");
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveAttribute("decoding", "async");
  await expect(image).not.toHaveAttribute("onerror");
});

for (const mode of ["READABILITY", "ARTICLE_EXTRACTOR"]) {
  test(`never runs an extracted page's event handlers in ${mode}`, async ({
    context,
    page,
  }) => {
    await installReaderResponder(context, true, "hostile");
    await installApiFixture(page);
    await page.goto("/");
    await selectSource(page);

    const modes = page.getByRole("combobox", { name: "Article display mode" });
    await expect(modes).toContainText("Reader (plain text)");
    await modes.selectOption(mode);
    await expect(
      page.getByText("Reader bridge content.", { exact: false }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".reader img")
          .evaluate((image: HTMLImageElement) => image.complete),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "readerHandlerRan")),
    ).toBeUndefined();
  });
}

for (const mode of ["READABILITY", "ARTICLE_EXTRACTOR"]) {
  test(`falls back to Feed mode on an element-heavy page in ${mode}`, async ({
    context,
    page,
  }) => {
    await installReaderResponder(context, true, "element-heavy");
    await installApiFixture(page);
    await page.goto("/");
    await selectSource(page);

    const modes = page.getByRole("combobox", { name: "Article display mode" });
    await modes.selectOption(mode);
    await expect(
      page.getByText(
        "This article is too large for Reader mode. Showing Feed mode.",
      ),
    ).toBeVisible();
    await expect(modes).toHaveValue("FEED");
    await expect(page.getByText("Feed article content")).toBeVisible();
  });
}

test("keeps Feed mode when the Reader bridge is unavailable", async ({
  page,
}) => {
  await installReaderResponder(page.context(), false);
  await openApp(page);
  await selectSource(page);

  await expect(
    page.getByRole("combobox", { name: "Article display mode" }),
  ).toHaveCount(0);
  await expect(page.getByText("Feed article content")).toBeVisible();
});

test("redirects expired protected requests to login", async ({ page }) => {
  const state = await openApp(page);
  await expect(page.getByText("Reading", { exact: true })).toBeVisible();

  state.authenticated = false;
  await selectSource(page);

  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe("/");
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 401 (Unauthorized)",
  ]);
  failures.length = 0;
});

const expectSignIn = async (page: Page, next: string, refusals = 1) => {
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe(next);
  const failures = browserFailures.get(page) ?? [];
  await expect
    .poll(() => failures)
    .toEqual(
      Array.from(
        { length: refusals },
        () =>
          "console.error: Failed to load resource: the server responded with a status of 401 (Unauthorized)",
      ),
    );
  failures.length = 0;
};

const confirm = (page: Page) =>
  page
    .getByRole("dialog")
    .getByRole("button", {
      name: /^(Change URL|Continue|Create|Delete|Rename)$/u,
    })
    .click();
const expiringMutations: {
  name: string;
  prepare?: (state: Awaited<ReturnType<typeof installApiFixture>>) => void;
  ready: (page: Page) => Promise<void>;
  refusals?: number;
  send: (page: Page) => Promise<void>;
}[] = [
  {
    name: "marking an article read",
    ready: async (page) => {
      await selectSource(page);
      await articleOptions(page).first().click();
    },
    refusals: 2,
    send: (page) => page.getByRole("button", { name: "Mark read" }).click(),
  },
  {
    name: "deleting an article",
    ready: async (page) => {
      await selectSource(page);
      await articleOptions(page).first().click();
    },
    refusals: 2,
    send: (page) => page.keyboard.press("Delete"),
  },
  {
    name: "renaming a source",
    ready: async (page) => {
      await selectSource(page);
      await page.getByRole("button", { name: "source properties" }).click();
      await page.getByLabel("Title").fill("Renamed Feed");
    },
    send: (page) => page.getByRole("button", { name: "Save" }).click(),
  },
  {
    name: "deleting a source",
    ready: async (page) => {
      await selectSource(page);
      await page.getByRole("button", { name: "delete source" }).click();
    },
    send: confirm,
  },
  {
    name: "renaming a folder",
    ready: async (page) => {
      await selectSource(page, "Reading");
      await page.getByRole("button", { name: "source properties" }).click();
      await page.getByRole("dialog").getByRole("textbox").fill("Archive");
    },
    send: confirm,
  },
  {
    name: "deleting an empty folder",
    prepare: (state) => state.removedSourceIds.push(3),
    ready: async (page) => {
      await selectSource(page, "Reading");
      await page.getByRole("button", { name: "delete source" }).click();
    },
    send: confirm,
  },
];
for (const { name, prepare, ready, refusals, send } of expiringMutations) {
  test(`a 401 from ${name} routes to sign-in`, async ({ page }) => {
    const state = await installApiFixture(page);
    prepare?.(state);
    await page.goto("/");
    await ready(page);
    state.authenticated = false;
    await send(page);
    await expectSignIn(page, "/", refusals);
  });
}

test("a removal refused for another account reloads the page as the account signed in now", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  const named: (string | null)[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE")
      named.push(request.headers()[accountHeader.toLowerCase()] ?? null);
  });
  const firstSession = sessionAnswer(page);
  await page.goto("/");
  await firstSession;
  await selectSource(page);
  await page.getByRole("button", { name: "delete source" }).click();
  state.account = 43;
  const reloadedSession = sessionAnswer(page);
  await confirm(page);
  await reloadedSession;
  await selectSource(page);
  await page.getByRole("button", { name: "delete source" }).click();
  await confirm(page);

  await expect.poll(() => state.removedSourceIds).toEqual([3]);
  expect(named).toEqual(["42", "43"]);
  const failures = browserFailures.get(page) ?? [];
  expect(failures).toEqual([
    "console.error: Failed to load resource: the server responded with a status of 412 (Precondition Failed)",
  ]);
  failures.length = 0;
});

for (const { booted, path } of [
  { booted: (page: Page) => sourceRow(page), path: "/" },
  {
    booted: (page: Page) =>
      page.getByLabel("Folder").getByRole("option", { name: "Reading" }),
    path: "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml",
  },
]) {
  test(`a tree poll's 401 routes to sign-in, returning to ${path}`, async ({
    page,
  }) => {
    await page.clock.install();
    const state = await openApp(page, {}, path);
    await expect(booted(page)).toBeAttached();
    state.authenticated = false;
    await expect
      .poll(async () => {
        await page.clock.runFor(30_000);
        return state.treeRequests;
      })
      .toBeGreaterThanOrEqual(2);
    await expectSignIn(page, path);
  });
}

const expiringAdminRequests: {
  name: string;
  ready?: (page: Page) => Promise<void>;
  send: (page: Page) => Promise<void>;
}[] = [
  {
    name: "re-sorting the source list",
    send: (page) => page.getByRole("button", { name: "URL" }).click(),
  },
  {
    name: "replacing a source URL",
    ready: async (page) => {
      await page.getByRole("button", { name: "Edit" }).click();
      await page
        .getByRole("dialog")
        .getByRole("textbox")
        .fill("https://news.example/moved.xml");
      await confirm(page);
      await expect(page.getByRole("dialog")).toContainText("Change");
    },
    send: confirm,
  },
  {
    name: "removing a source",
    ready: (page) => page.getByRole("button", { name: "Remove" }).click(),
    send: confirm,
  },
];
for (const { name, ready, send } of expiringAdminRequests) {
  test(`a 401 from ${name} on the admin page routes to sign-in`, async ({
    page,
  }) => {
    const state = await openApp(page, {}, "/admin");
    await expect(
      page.getByRole("link", { name: "https://news.example/feed.xml" }),
    ).toBeVisible();
    await ready?.(page);
    state.authenticated = false;
    await send(page);
    await expectSignIn(page, "/admin");
  });
}

for (const [hash, tab, card] of [
  ["#signal", "Lists", "New articles"],
  ["#data", "Import & export", "Import OPML"],
  ["#appearance", "Appearance", "Display"],
  ["#nonsense", "Reading", "Marking as read"],
] as const)
  test(`/options${hash} opens the ${tab} tab`, async ({ page }) => {
    await openApp(page, {}, `/options${hash}`);
    await expect(
      page.getByRole("heading", { exact: true, name: card }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { exact: true, name: tab }),
    ).toHaveAttribute("aria-current", "true");
    await expect(
      page.getByRole("navigation", { name: "Options sections" }),
    ).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

test("each Options tab says whether it applies to this device or the account", async ({
  page,
}) => {
  await openApp(page, {}, "/options");
  await expect(page.getByText("Saved on this device only.")).toBeVisible();
  await page.getByRole("link", { exact: true, name: "Account" }).click();
  await expect(
    page.getByText("Applies to your account on every device."),
  ).toBeVisible();
});

for (const width of [390, 594])
  test(`every Options tab is fully visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ height: 844, width });
    await openApp(page, {}, "/options#import-export");
    const nav = page.getByRole("navigation", { name: "Options sections" });
    const strip = await nav.boundingBox();
    const tabs = await Promise.all(
      (await nav.getByRole("link").all()).map((tab) => tab.boundingBox()),
    );
    expect(tabs).toHaveLength(6);
    for (const box of tabs)
      expect(
        Boolean(
          strip &&
          box &&
          box.x >= strip.x &&
          box.x + box.width <= strip.x + strip.width &&
          box.y >= strip.y &&
          box.y + box.height <= strip.y + strip.height,
        ),
      ).toBe(true);
  });

test("a regular user on the admin page is told it is for admins", async ({
  page,
}) => {
  await openApp(page, { notAdmin: true }, "/admin");
  await expect(
    page.getByText("This page is for administrators."),
  ).toBeVisible();
  await expect(page.getByText("Unauthorized")).toHaveCount(0);
  await expect(page.getByLabel("Sort by")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to your feeds" }).click();
  await expect(page).toHaveURL("/");
  (browserFailures.get(page) ?? []).length = 0;
});

test("surfaces tree failures without masquerading as logout", async ({
  page,
}) => {
  await openApp(page, { treeFailure: true });

  expect(new URL(page.url()).pathname).toBe("/");
  const failure = page.getByRole("complementary", { name: "Feeds" });
  await expect(failure.getByRole("alert")).toContainText(
    "The FeedFathom server ran into a problem. Try again in a moment.",
  );
  await expect(
    failure.getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  await expect(failure.getByText("Details")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Login" })).toHaveCount(0);
});

test("an admin can open the details behind a tree failure", async ({
  page,
}) => {
  await openApp(page, { admin: true, treeFailure: true });
  const failure = page.getByRole("complementary", { name: "Feeds" });
  await failure.getByText("Details").click();
  await expect(failure.getByRole("alert")).toContainText(
    "Invalid response from /api/tree (200)",
  );
  await expect(failure.getByRole("alert")).not.toContainText("HTTP 200");
});

const goneFeed = {
  reason:
    "Failed to load data for https://news.example/feed.xml, received status 404",
};

test("a feed failing for over a day keeps its articles under a notice", async ({
  page,
}) => {
  await openApp(page, { failing: { ...goneFeed, daysSinceSuccess: 2 } });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(1);
  const notice = page.locator(".feed-notice");
  await expect(notice).toContainText(
    "This feed seems to have moved or been removed.",
  );
  await expect(notice).toContainText("Not updated since");
  await expect(notice.getByRole("button", { name: "Edit feed" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(notice.getByText("Details")).toHaveCount(0);
  await expect(notice).not.toContainText("404");
  await page.locator("button.source").filter({ hasText: "Today" }).click();
  await expect(page.locator(".feed-notice")).toHaveCount(0);
});

test("an admin sees the status and reason behind a failing feed", async ({
  page,
}) => {
  await openApp(page, {
    admin: true,
    failing: { ...goneFeed, daysSinceSuccess: 2 },
  });
  await selectSource(page);
  const notice = page.locator(".feed-notice");
  await notice.getByText("Details").click();
  await expect(notice).toContainText(goneFeed.reason);
  await expect(notice).not.toContainText("HTTP 404");
});

test("a feed down for less than a day lists its articles without a notice", async ({
  page,
}) => {
  await openApp(page, {
    failing: { daysSinceSuccess: 0.5, reason: "connect ECONNREFUSED 1.2.3.4" },
  });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(1);
  await expect(page.locator(".feed-notice")).toHaveCount(0);
});

test("a superseded tree request settles on its replacement", async ({
  page,
}) => {
  await installApiFixture(page);
  const held: Array<() => void> = [];
  await page.route("**/api/tree", async (route) => {
    await new Promise<void>((release) => held.push(release));
    await route.fallback().catch(() => undefined);
  });
  await page.goto("/");
  await expect.poll(() => held.length).toBe(1);

  await page.getByRole("button", { name: "refresh" }).click();
  await expect.poll(() => held.length).toBe(2);
  held[1]!();
  held[0]!();

  await expect(sourceRow(page)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("j and k move the selection like the arrow keys", async ({ page }) => {
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page).first().focus();
  await expect(articleOptions(page).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("j");
  await expect(
    page.getByRole("option", { name: /Second article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: /Second article/ }),
  ).toBeFocused();

  await page.keyboard.press("k");
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toBeFocused();
});

test("o moves focus between the article list and the reader pane", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");
  await selectSource(page);
  await expect(articleOptions(page).first()).toBeFocused();

  await page.keyboard.press("o");
  const reader = page.getByRole("article", { name: "Reader" });
  await expect(reader).toBeVisible();
  await expect(reader).toBeFocused();

  await page.keyboard.press("o");
  await expect(articleOptions(page).first()).toBeFocused();
});

test("leaves the article context menu to the browser", async ({ page }) => {
  await openApp(page);

  await selectSource(page);
  await articleOptions(page).first().click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test.describe("touch devices", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });

  test("leaves long-press on an article to the browser", async ({ page }) => {
    await installApiFixture(page);
    await page.goto("/");
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);

    await selectSource(page);
    await articleOptions(page).first().click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);

    const styles = await articleOptions(page)
      .first()
      .evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          callout: computed.getPropertyValue("-webkit-touch-callout"),
          userSelect: computed.userSelect,
        };
      });
    expect(styles.callout).not.toBe("none");
    expect(styles.userSelect).not.toBe("none");
  });
});

test("labels the article filter visibly", async ({ page }) => {
  await openApp(page);
  await selectSource(page);
  await expect(page.locator(".article-filter-field")).toContainText("Show");
  await expect(page.getByRole("combobox", { name: "Show" })).toHaveValue(
    "unread",
  );
});

test("? opens the shortcut help dialog and Escape closes it", async ({
  page,
}) => {
  await openApp(page);
  await selectSource(page);
  await articleOptions(page).first().focus();

  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Keyboard shortcuts");
  await expect(
    dialog.getByRole("heading", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await expect(dialog.getByText("Mark read / unread")).toBeVisible();
  await expect(dialog.locator("dt").filter({ hasText: "Ctrl" })).toHaveText([
    "Ctrl + ↓ or Ctrl + ↑",
    "Ctrl + A",
  ]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(":focus")).toHaveAttribute("role", "option");
});

test("a second dialog request cancels the one still pending", async ({
  page,
}) => {
  await openApp(page);
  await expect(page.locator(".sources-pane .source").first()).toBeFocused();
  const opener = page.getByRole("button", { name: "add folder" });
  await opener.focus();

  const first = await page.evaluate(async (url) => {
    const { confirmDialog, promptDialog }: typeof Dialogs = await import(url);
    const pending = confirmDialog("First?", "", { confirmLabel: "OK" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    void promptDialog("Second", "Name", {
      confirmLabel: "OK",
      initial: "kept",
    });
    return await pending;
  }, "/dialog.tsx");
  expect(first).toBe(false);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("Second");
  await expect(dialog.getByRole("textbox")).toHaveValue("kept");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the options page can open the shortcut help dialog without a keyboard", async ({
  page,
}) => {
  await openApp(page, {}, "/options#keyboard");

  await page.getByRole("button", { name: "Show keyboard shortcuts" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Keyboard shortcuts" }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("typing j in the feed filter does not move the selection", async ({
  page,
}) => {
  await openApp(page, { multipleArticles: true });
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);
  await articleOptions(page).first().focus();
  await expect(articleOptions(page).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const filter = page.getByRole("searchbox", { name: "Filter feeds" });
  await filter.focus();
  await page.keyboard.type("j");
  await expect(articleOptions(page).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("j");
});

test.describe("session restoration", () => {
  test("a reload restores the selected article and the list scroll", async ({
    page,
  }) => {
    await installApiFixture(page, { manyArticles: true });
    await page.goto("/");

    await selectSource(page);
    const target = articleOptions(page).nth(30);
    await target.click();
    await expect(page.locator(".reader h1")).toHaveText("Article 130");

    const list = page.locator(".article-list");
    await list.evaluate((element) => {
      element.scrollTop = 900;
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(
              sessionStorage.getItem("feedfathom:reading-session:v1") ?? "null",
            )?.app?.listScrollTop,
        ),
      )
      .toBe(900);

    await page.reload();
    await expect(page.locator(".reader h1")).toHaveText("Article 130");
    await expect(list).toHaveJSProperty("scrollTop", 900);
    await expect(articleOptions(page).nth(30)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("a reload resumes the scroll position inside a long article", async ({
    page,
  }) => {
    await installApiFixture(page, { longArticle: true });
    await page.goto("/");

    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    const reader = page.locator(".reader");
    const halfScroll = await reader.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.5;
      return element.scrollTop;
    });
    expect(halfScroll).toBeGreaterThan(200);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(
              sessionStorage.getItem("feedfathom:reading-session:v1") ?? "null",
            )?.reader?.[0]?.ratio,
        ),
      )
      .toBeCloseTo(0.5, 2);

    await page.reload();
    await expect(page.locator(".reader h1")).toHaveText("First article");
    await expect(reader).toHaveJSProperty("scrollTop", halfScroll);
  });

  test("with the preference off, no snapshot is written and nothing restores", async ({
    page,
  }) => {
    await page.clock.install();
    await installApiFixture(page, { longArticle: true });
    await page.addInitScript(() => {
      localStorage.setItem("rememberReadingPosition", "off");
    });
    await page.goto("/");

    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    const reader = page.locator(".reader");
    await reader.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener("scroll", () => resolve(), { once: true });
          element.scrollTop =
            (element.scrollHeight - element.clientHeight) * 0.5;
        }),
    );
    await page.clock.runFor(1_000);

    await page.reload();
    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    await expect
      .poll(() => reader.evaluate((element) => element.scrollTop))
      .toBe(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("feedfathom:reading-session:v1"),
      ),
    ).toBeNull();
  });

  test("an update reload resumes the article with the preference off", async ({
    page,
  }) => {
    await installApiFixture(page, { longArticle: true });
    await page.addInitScript(() => {
      localStorage.setItem("rememberReadingPosition", "off");
    });
    await page.goto("/");

    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    const reader = page.locator(".reader");
    const halfScroll = await reader.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.5;
      return element.scrollTop;
    });
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", { data: { type: "shell-updated" } }),
      );
      Object.defineProperty(document, "hidden", { value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await reloaded;

    await expect(page.locator(".reader h1")).toHaveText("First article");
    await expect(reader).toHaveJSProperty("scrollTop", halfScroll);
    expect(
      await page.evaluate(() => [
        sessionStorage.getItem("feedfathom:reading-session:v1"),
        localStorage.getItem("feedfathom:reading-session:v1"),
      ]),
    ).toEqual([null, null]);
    await page.reload();
    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    await expect
      .poll(() => reader.evaluate((element) => element.scrollTop))
      .toBe(0);
  });

  test("a reload restores a multi-row selection and the focus cursor", async ({
    page,
  }) => {
    await installApiFixture(page, { manyArticles: true });
    await page.goto("/");

    await selectSource(page);
    await articleOptions(page).nth(3).click();
    await articleOptions(page)
      .nth(5)
      .click({ modifiers: ["Shift"] });
    await page.keyboard.press("Control+ArrowDown");
    await page.keyboard.press("Control+ArrowDown");
    await expect(articleOptions(page).nth(7)).toBeFocused();

    await page.reload();
    await Promise.all(
      [3, 4, 5].map((index) =>
        expect(articleOptions(page).nth(index)).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      ),
    );
    await expect(articleOptions(page).nth(6)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(articleOptions(page).nth(7)).toBeFocused();
    await articleOptions(page)
      .nth(1)
      .click({ modifiers: ["Shift"] });
    await Promise.all(
      [1, 2, 3].map((index) =>
        expect(articleOptions(page).nth(index)).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      ),
    );
    await expect(articleOptions(page).nth(4)).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  test("a reload restores a search and its open result", async ({ page }) => {
    await installApiFixture(page);
    await page.goto("/");

    const search = page.getByLabel("Search articles");
    await search.fill("subscribed");
    await search.press("Enter");
    await page.getByRole("option", { name: /Subscribed article/ }).click();
    await expect(page.locator(".reader h1")).toHaveText("Subscribed article");

    await page.reload();
    await expect(search).toHaveValue("subscribed");
    await expect(page.locator(".reader h1")).toHaveText("Subscribed article");
    await expect(page.getByLabel("Show")).toHaveValue("all");
  });

  test("a stale snapshot (deleted source) boots normally", async ({ page }) => {
    await installApiFixture(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        "feedfathom:reading-session:v1",
        JSON.stringify({
          app: {
            articleFilter: "unread",
            articleId: 11,
            listIds: [11],
            listScrollTop: 0,
            nodeType: "source",
            nodeUid: "999",
          },
          reader: [],
          version: 1,
        }),
      );
    });
    await page.goto("/");

    await expect(page.getByText("Select a feed to read.")).toBeVisible();
    await expect(page.locator(".dashboard-alert")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("feedfathom:reading-session:v1"),
      ),
    ).toBeNull();
  });
});

const menuTreeSource = (uid: string, name: string): TreeNode => ({
  favicon: null,
  homeUrl: `https://${uid}.example/`,
  kind: "feed",
  name,
  type: "source",
  uid,
  unreadCount: 1,
  xmlUrl: `https://${uid}.example/feed.xml`,
});
const routeTwoSourceTree = async (
  page: Page,
  state: Awaited<ReturnType<typeof installApiFixture>>,
) => {
  await page.route("**/api/tree", (route) =>
    respond(route, treeResponse, {
      tree: [
        {
          children: [
            menuTreeSource("3", "Tech News"),
            menuTreeSource("9", "Tech Preview"),
          ].filter(
            (source) => !state.removedSourceIds.includes(Number(source.uid)),
          ),
          name: state.updatedFolder?.name ?? "Reading",
          type: "folder",
          uid: "7",
        },
      ],
    }),
  );
};
const openRowMenu = async (page: Page, name: string) => {
  await page
    .locator("button.source")
    .filter({ hasText: name })
    .first()
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
};
const expectSelectedRow = async (page: Page, name: RegExp) => {
  await expect(page.getByRole("treeitem", { name })).toHaveAttribute(
    "aria-selected",
    "true",
  );
};

test("the tree context menu leaves the article paging scope alone", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await routeTwoSourceTree(page, state);
  const bodies: { cursor?: number; sources: number[] }[] = [];
  let releasePage: (() => void) | undefined;
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = Value.Parse(articlesRequest, route.request().postDataJSON());
    bodies.push(body);
    if (body.cursor !== undefined)
      await new Promise<void>((release) => (releasePage = release));
    const start = body.cursor === undefined ? 1 : articlePageSize + 1;
    const size = body.cursor === undefined ? articlePageSize : 3;
    await respond(
      route,
      articlesResponse,
      Array.from({ length: size }, (_, index) => pagedSummary(start + index)),
    );
  });
  await page.route("**/api/article?*", fulfillPagedArticle);
  await page.goto("/");
  await selectSource(page);
  const rows = page.locator(".article-list .article");
  await expect(rows).toHaveCount(articlePageSize);

  await openRowMenu(page, "Tech Preview");
  await page.keyboard.press("Escape");
  await expectSelectedRow(page, /Tech News/);

  await page.locator(".article-list").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ cursor: articlePageSize, sources: [3] });

  await openRowMenu(page, "Reading");
  await page.keyboard.press("Escape");
  releasePage!();
  await expect(rows).toHaveCount(articlePageSize + 3);
  expect(bodies).toHaveLength(2);
  await expectSelectedRow(page, /Tech News/);
});

test("switching feeds does not wait on the old feed's next page", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await routeTwoSourceTree(page, state);
  const pageRequests: number[][] = [];
  const held = new Map<number, () => void>();
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = Value.Parse(articlesRequest, route.request().postDataJSON());
    const source = body.sources[0]!;
    const offset = body.cursor === undefined ? 1 : articlePageSize + 1;
    if (body.cursor !== undefined) {
      pageRequests.push(body.sources);
      await new Promise<void>((release) => held.set(source, release));
    }
    const size = body.cursor === undefined ? articlePageSize : 3;
    await respond(
      route,
      articlesResponse,
      Array.from({ length: size }, (_, index) =>
        pagedSummary(source * 1000 + offset + index),
      ),
    ).catch(() => {});
  });
  await page.route("**/api/article?*", fulfillPagedArticle);
  const list = page.locator(".article-list");
  const rows = list.locator(".article");
  const scrollToEnd = () =>
    list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  await page.goto("/");

  await selectSource(page);
  await expect(rows).toHaveCount(articlePageSize);
  await scrollToEnd();
  await expect.poll(() => pageRequests).toEqual([[3]]);

  await selectSource(page, "Tech Preview");
  await expect(rows.first()).toContainText("Article 9001");
  await expect(rows).toHaveCount(articlePageSize);
  await scrollToEnd();
  await expect.poll(() => pageRequests).toEqual([[3], [9]]);

  held.get(3)!();
  await list.evaluate((element) => {
    element.scrollTop -= 10;
  });
  await scrollToEnd();
  held.get(9)!();
  await expect(rows).toHaveCount(articlePageSize + 3);
  expect(pageRequests).toEqual([[3], [9]]);
});

test("a failed delete leaves the feed switched to since alone", async ({
  page,
}) => {
  const state = await installApiFixture(page, { multipleArticles: true });
  await routeTwoSourceTree(page, state);
  let failDelete: (() => void) | undefined;
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "DELETE") return await route.fallback();
    await new Promise<void>((release) => (failDelete = release));
    await malformed(route, { removed: "malformed" });
  });
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("option", { name: /Second article/ }).click();
  await page.keyboard.press("Delete");
  await expect(articleOptions(page)).toHaveCount(2);
  await expect.poll(() => failDelete).toBeDefined();

  await selectSource(page, "Tech Preview");
  await expect(
    page.getByRole("option", { name: /Subscribed article/ }),
  ).toBeVisible();
  failDelete!();
  await expect(page.getByRole("alert")).toContainText(
    "The FeedFathom server ran into a problem. Try again in a moment.",
  );
  await expect(articleOptions(page)).toHaveText([/Subscribed article/]);
  await expectSelectedRow(page, /Tech Preview/);
});

test("tree context menu actions target the clicked row", async ({ page }) => {
  const state = await installApiFixture(page);
  await routeTwoSourceTree(page, state);
  await page.goto("/");
  await selectSource(page);
  const firstArticle = page
    .locator(".article-list .article")
    .filter({ hasText: "First article" });
  await expect(firstArticle).toBeVisible();

  await openRowMenu(page, "Reading");
  await page.getByRole("menuitem", { name: "Rename folder" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox")).toHaveValue("Reading");
  await dialog.getByRole("textbox").fill("Archive");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(
    page.locator("button.source.folder").filter({ hasText: "Archive" }),
  ).toBeVisible();
  expect(state.updatedFolder).toEqual({ name: "Archive" });
  await expectSelectedRow(page, /Tech News/);

  await openRowMenu(page, "Tech Preview");
  await page.getByRole("menuitem", { name: "Edit feed" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Tech Preview");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectSelectedRow(page, /Tech News/);

  await openRowMenu(page, "Tech Preview");
  await page.getByRole("menuitem", { name: "Unsubscribe" }).click();
  await expect(dialog).toContainText('Delete "Tech Preview"?');
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(
    page.locator("button.source").filter({ hasText: "Tech Preview" }),
  ).toHaveCount(0);
  expect(state.removedSourceIds).toEqual([9]);
  await expectSelectedRow(page, /Tech News/);
  await expect(firstArticle).toBeVisible();
});

const treeHolds = async (page: Page, hold: (request: number) => boolean) => {
  const released: Array<() => void> = [];
  let requests = 0;
  await page.route("**/api/tree", async (route) => {
    requests += 1;
    if (hold(requests))
      await new Promise<void>((release) => released.push(release));
    await route.fallback().catch(() => undefined);
  });
  return { released, requests: () => requests };
};
const leaveDashboard = async (page: Page) => {
  await page.getByRole("button", { name: "options" }).click();
  await expect(page.getByRole("heading", { name: "Options" })).toBeVisible();
};

test("unmounting during the boot tree load starts no poll", async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize({ height: 844, width: 390 });
  await installApiFixture(page);
  const tree = await treeHolds(page, (request) => request === 1);
  await page.goto("/");
  await expect.poll(() => tree.released.length).toBe(1);

  await leaveDashboard(page);
  tree.released[0]!();
  await page.clock.runFor(10 * 60_000);
  expect(tree.requests()).toBe(1);
});

test("unmounting during a poll leaves one live loop after remounting", async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize({ height: 844, width: 390 });
  await installApiFixture(page);
  const tree = await treeHolds(page, (request) => request === 2);
  await page.goto("/");
  await expect(sourceRow(page)).toBeVisible();

  await page.clock.runFor(30_000);
  await expect.poll(() => tree.released.length).toBe(1);
  await leaveDashboard(page);
  tree.released[0]!();
  await page.clock.runFor(10 * 60_000);
  expect(tree.requests()).toBe(2);

  await page.getByRole("link", { name: "Home" }).click();
  await expect.poll(() => tree.requests()).toBe(3);
  await expect(sourceRow(page)).toBeVisible();
  await page.clock.runFor(30_000);
  await expect.poll(() => tree.requests()).toBe(4);
  await page.clock.runFor(59_000);
  expect(tree.requests()).toBe(4);
  await page.clock.runFor(1_000);
  await expect.poll(() => tree.requests()).toBe(5);
  await expect(page.getByText(/new articles?\./)).toHaveCount(0);
});

test("an article event refreshes the tree ahead of the poll", async ({
  page,
}) => {
  await page.clock.install();
  await installApiFixture(page);
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  await page.route("**/api/events", async (route) => {
    await released;
    await route.fulfill({
      body: 'retry: 600000\ndata: {"count":3,"sourceId":3}\n\n',
      contentType: "text/event-stream",
    });
  });
  await page.goto("/");
  const row = sourceRow(page);
  await expect(row.locator(".unread-count")).toHaveText("2");

  let treeRequests = 0;
  await page.route("**/api/tree", (route) => {
    treeRequests++;
    return respond(route, treeResponse, {
      tree: [
        {
          children: [
            {
              favicon: null,
              homeUrl: "https://news.example/",
              kind: "feed",
              name: "Tech News",
              type: "source",
              uid: "3",
              unreadCount: 5,
              xmlUrl: "https://news.example/feed.xml",
            },
          ],
          name: "Reading",
          type: "folder",
          uid: "7",
        },
      ],
    });
  });
  release();
  await expect
    .poll(async () => {
      await page.clock.runFor(500);
      return treeRequests;
    })
    .toBe(1);
  await expect(row.locator(".unread-count")).toHaveText("5");
  await expect(page.getByText("3 new articles.")).toBeVisible();
});

async function navigatePastHeldArticles(page: Page) {
  const held: Array<() => void> = [];
  const aborted = new Set<string>();
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/article" && request.serviceWorker() === null)
      aborted.add(url.searchParams.get("article")!);
  });
  await page.context().route("**/api/article?*", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("article");
    if (id !== "13") await new Promise<void>((release) => held.push(release));
    await route.fallback().catch(() => {});
  });
  await selectSource(page);
  await expect.poll(() => held.length).toBe(1);
  await articleOptions(page).first().focus();
  await page.keyboard.press("j");
  await expect.poll(() => held.length).toBe(2);
  await page.keyboard.press("j");

  await expect(
    page.getByRole("heading", { name: "Third article" }),
  ).toBeVisible();
  await expect.poll(() => [...aborted].toSorted()).toEqual(["11", "12"]);
  for (const release of held) release();
  await expect(
    page.getByRole("heading", { name: "Third article" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
}

test("rapid navigation cancels the bodies of the articles it passes", async ({
  page,
}) => {
  await installApiFixture(page.context(), { multipleArticles: true });
  await page.goto("/");
  await navigatePastHeldArticles(page);
});

type HeldTree = ((route: Route) => Promise<void>) | undefined;
const reloadWithHeldTree = async (
  page: Page,
  beforeReload?: () => Promise<void>,
) => {
  const context = page.context();
  await installApiFixture(context);
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.reload();
  await page.waitForFunction(async () =>
    Boolean(await caches.match("/api/tree")),
  );
  await beforeReload?.();
  let release!: (response?: HeldTree) => void;
  const held = new Promise<HeldTree>((resolve) => {
    release = resolve;
  });
  await context.route("**/api/tree", async (route) => {
    const answer = await held;
    await (answer ? answer(route) : route.fallback());
  });
  await page.reload();
  await expect(sourceRow(page)).toBeVisible();
  await expect(page.locator(".tree.skeleton")).toHaveCount(0);
  return release;
};

test("logging out from an uncontrolled page drops the API cache", async ({
  page,
}) => {
  await openApp(page, {}, "/options#account");
  await page.evaluate(async () => {
    const cache = await caches.open("api-test");
    await cache.put("/api/tree", Response.json({ tree: [] }));
  });
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).filter((key) => key.startsWith("api-")),
    ),
  ).toEqual([]);
});

test("signing in from an uncontrolled page drops the API cache", async ({
  page,
}) => {
  await openApp(page, { authenticated: false }, "/login");
  await page.evaluate(async () => {
    const cache = await caches.open("api-test");
    await cache.put("/api/tree", Response.json({ tree: [] }));
  });
  await page.getByLabel("Email").fill("reader@example.com");
  await page.getByLabel("Password").fill("password");
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).filter((key) => key.startsWith("api-")),
    ),
  ).toEqual([]);
});

const downloaded = (page: Page) =>
  page.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.startsWith("api-"));
    if (!name) return [];
    const keys = await (await caches.open(name)).keys();
    return keys
      .map((request) => new URL(request.url))
      .filter((url) => url.pathname === "/sw-offline-article")
      .map((url) => url.search);
  });

const downloadUnread = async (page: Page) => {
  const context = page.context();
  await context.addInitScript(() =>
    localStorage.setItem("offlineUnread", "on"),
  );
  const state = await installApiFixture(context, { multipleArticles: true });
  await context.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const publishedAt = new Date().toJSON();
    return respond(
      route,
      articlesResponse,
      ["First", "Second", "Third"].map((title, index) => ({
        author: "News Author",
        id: 11 + index,
        publishedAt,
        read: false,
        revision: null,
        sourceId: 3,
        title: `${title} article`,
        url: `https://articles.example/${index}`,
      })),
    );
  });
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await expect.poll(() => downloaded(page)).toHaveLength(3);
  return state;
};

const disconnected = (route: Route) => route.abort("internetdisconnected");

const removeOffline = async (page: Page, server?: () => Promise<unknown>) => {
  const context = page.context();
  const state = await downloadUnread(page);
  const sessionAnswered = sessionAnswer(page);
  await page.reload();
  await sessionAnswered;
  await selectSource(page);
  await articleOptions(page).filter({ hasText: "Second article" }).click();
  await context.route("**/api/**", disconnected);
  await context.setOffline(true);
  await page.keyboard.press("Delete");
  await expect(articleOptions(page)).toHaveCount(2);
  await expect(
    articleOptions(page).filter({ hasText: "Second article" }),
  ).toHaveCount(0);
  expect(state.removedArticleIds).toEqual([]);
  await server?.();
  await context.unroute("**/api/**", disconnected);
  await context.setOffline(false);
  await page.evaluate(() => fetch("/api/tree"));
  return state;
};

test.describe("under a controlling service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("rapid navigation cancels the bodies of the articles it passes", async ({
    page,
  }) => {
    await installApiFixture(page.context(), { multipleArticles: true });
    await page.goto("/");
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await navigatePastHeldArticles(page);
  });

  test("a controlled load fetches the tree once", async ({ page }) => {
    const context = page.context();
    await installApiFixture(context);
    await page.goto("/");
    await page.waitForFunction(() => navigator.serviceWorker.controller);

    const fromPage: string[] = [];
    const fromWorker: string[] = [];
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/tree")
        (request.serviceWorker() ? fromWorker : fromPage).push(
          url.pathname + url.search,
        );
    });
    await page.reload();
    await expect(sourceRow(page)).toBeVisible();
    expect({ fromPage: fromPage.toSorted(), fromWorker }).toEqual({
      fromPage: ["/api/tree", "/api/tree?cached"],
      fromWorker: ["/api/tree"],
    });
  });

  test("a controlled reload paints the cached tree, then the fresh one", async ({
    page,
  }) => {
    const release = await reloadWithHeldTree(page);
    await expect(
      page.getByRole("treeitem", { name: "Tech News 2 unread" }),
    ).toBeVisible();

    release((route) =>
      respond(route, treeResponse, {
        tree: [
          {
            favicon: null,
            homeUrl: "https://news.example/",
            kind: "feed",
            name: "Tech News",
            type: "source",
            uid: "3",
            unreadCount: 5,
            xmlUrl: "https://news.example/feed.xml",
          },
        ],
      }),
    );
    await expect(
      page.getByRole("treeitem", { name: "Tech News 5 unread" }),
    ).toBeVisible();
    await expect(page.getByText(/new articles?\./)).toHaveCount(0);
  });

  test("a feed picked from the cached tree replaces the session restore", async ({
    page,
  }) => {
    const snapshotNode = () =>
      page.evaluate(
        () =>
          JSON.parse(
            sessionStorage.getItem("feedfathom:reading-session:v1") ?? "null",
          )?.app?.nodeUid,
      );
    const release = await reloadWithHeldTree(page, async () => {
      await selectSource(page, "Reading");
      await expect.poll(snapshotNode).toBe("7");
    });
    await selectSource(page);
    release();
    await page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/tree",
    );
    await expectSelectedRow(page, /^Tech News/);
    expect(await snapshotNode()).toBe("3");
  });

  test("a downloaded unread article opens offline without a request", async ({
    page,
  }) => {
    await downloadUnread(page);
    await selectSource(page);
    await expect(articleOptions(page)).toHaveCount(3);
    const fromWorker: string[] = [];
    page.context().on("request", (request) => {
      if (request.serviceWorker()) fromWorker.push(request.url());
    });
    await page.context().setOffline(true);
    await articleOptions(page).filter({ hasText: "Third article" }).click();
    await expect(
      page.locator(".reader").getByRole("heading", { name: "Third article" }),
    ).toBeVisible();
    expect(fromWorker).toEqual([]);
    await page.context().setOffline(false);
  });

  test("offline, the downloaded articles are listed and open", async ({
    page,
  }) => {
    await downloadUnread(page);
    await page.reload();
    await expect(page.locator("button.source").first()).toBeVisible();
    await page
      .context()
      .route("**/api/**", (route) => route.abort("internetdisconnected"));
    await page.context().setOffline(true);
    await selectSource(page, "Reading");
    await expect(articleOptions(page)).toHaveCount(3);
    await articleOptions(page).filter({ hasText: "Third article" }).click();
    await expect(
      page.locator(".reader").getByRole("heading", { name: "Third article" }),
    ).toBeVisible();
    await page.context().setOffline(false);
    (browserFailures.get(page) ?? []).length = 0;
  });

  test("switching the download off, and logging out, drop stored bodies", async ({
    page,
  }) => {
    await downloadUnread(page);
    await page.goto("/options");
    await page
      .getByRole("checkbox", {
        name: "Download unread articles for offline reading",
      })
      .uncheck();
    await expect.poll(() => downloaded(page)).toEqual([]);

    await page.goto("/");
    await expect.poll(() => downloaded(page)).toHaveLength(3);
    await page.goto("/options");
    await page.getByRole("link", { exact: true, name: "Account" }).click();
    await page.getByRole("button", { name: "Logout" }).click();
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
    expect(await downloaded(page)).toEqual([]);
  });

  test("a 401 behind the cached tree still routes to sign-in", async ({
    page,
  }) => {
    const release = await reloadWithHeldTree(page);
    release((route) => refuse(route, 401, "Unauthorized"));
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
    (browserFailures.get(page) ?? []).length = 0;
  });

  test("an offline removal answers at once and replays back online for its account", async ({
    page,
  }) => {
    const replayedFor: (string | null)[] = [];
    const state = await removeOffline(page, () =>
      page.context().route("**/api/articles", async (route) => {
        if (route.request().method() === "DELETE")
          replayedFor.push(await route.request().headerValue(accountHeader));
        return route.fallback();
      }),
    );
    await expect.poll(() => state.removedArticleIds).toEqual([12]);
    expect(replayedFor).toEqual(["42"]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a replay the server refuses tells the reader the removal was lost", async ({
    page,
  }) => {
    const state = await removeOffline(page, () =>
      page
        .context()
        .route("**/api/articles", (route) =>
          route.request().method() === "DELETE"
            ? refuse(route, 404, "Not found")
            : route.fallback(),
        ),
    );
    await expect(page.getByRole("alert")).toContainText(
      "A change made while offline could not be applied and was discarded.",
    );
    expect(state.removedArticleIds).toEqual([]);
  });
});
