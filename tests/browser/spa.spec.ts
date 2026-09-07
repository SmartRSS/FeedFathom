import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";
import { installApiFixture } from "./api-fixture.ts";

// The real service worker (see src/spa/public/sw.js) takes /api/* fetches
// over itself once it activates -- its own internal fetch() calls run
// outside the page's network stack, so they bypass installApiFixture's
// page.route() mock entirely and hit vite's real dev proxy instead
// (which has no backend behind it here). A slow-enough test lets the SW
// finish installing/activating mid-run and starts failing partway through
// with ECONNREFUSED; blocking it keeps every request on the mocked path.
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
) {
  await context.addInitScript((isAvailable) => {
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
            html: `<html><head><title>Bridged article</title></head><body><article><h1>Bridged article</h1><p>${"Reader bridge content. ".repeat(40)}</p></article></body></html>`,
            id: request.id,
            ok: true,
            type: "response",
            version: 1,
          },
          location.origin,
        );
      }
    });
  }, available);
}

// One row of a stubbed article page, in the shape articlesResponse wants.
const pagedSummary = (id: number) => ({
  author: "Author",
  group: "Older",
  id,
  publishedAt: "2026-07-20T10:00:00.000Z",
  read: false,
  sourceId: 3,
  title: `Article ${id}`,
  url: `https://articles.example/${id}`,
});

// The article rows are role="option" inside the list. So are the three
// options of the filter <select> beside them, which is why this is scoped
// rather than asking the page for every option it has.
const articleOptions = (page: Page) =>
  page.locator(".article-list").getByRole("option");

const selectSource = async (page: Page, name = "Tech News") => {
  await page.locator("button.source").filter({ hasText: name }).click();
};

test.beforeEach(async ({ page }) => {
  guardBrowser(page);
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? []).toEqual([]);
});

test("shows an all-caught-up empty state for a feed with no unread", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");

  await page
    .locator("button.source")
    .filter({ hasText: "Tech News" })
    .first()
    .click();
  // The fixture's article list for the source is nonempty; right after the
  // list renders, remove the single article and the fallback appears.
  await page.getByRole("button", { name: "delete articles" }).click();
  await expect(page.getByText("All caught up.")).toBeVisible();
});

test("opens a keyboard-dismissable context menu on tree rows", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");

  // The virtual Today row heads the tree but is a view, not a feed: no
  // menu for it.
  await page.locator("button.source").first().click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);

  const row = page
    .locator("button.source")
    .filter({ hasText: "Tech News" })
    .first();
  await row.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Copy feed URL" }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("keeps the context menu inside a narrow viewport", async ({ page }) => {
  await installApiFixture(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");

  // Long-press near a screen edge is the common case on touch, so open
  // the menu from a point a few pixels from the right edge of a row.
  await page
    .locator("button.source")
    .filter({ hasText: "Tech News" })
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

test("boots Solid and renders the authenticated nested tree", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");

  await expect(page.locator("#app")).not.toBeEmpty();
  await expect(page.getByText("Reading", { exact: true })).toBeVisible();
  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toBeVisible();
});

test("offers first-run guidance while the tree is empty", async ({ page }) => {
  await installApiFixture(page);
  // Registered after the fixture's own **/api/** handler, so it wins.
  await page.route("**/api/tree", (route) =>
    route.fulfill({
      body: JSON.stringify({ tree: [] }),
      contentType: "application/json",
      status: 200,
    }),
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

// A nested list also matches .tree, so it easily picks that rule's
// scroll-container treatment back up and reserves a scrollbar gutter of its
// own, indenting every source row's right edge by the gutter width while the
// folder rows around it stay put. The visible symptom is the unread counts
// failing to line up, so assert on those directly.
test("right-aligns folder and source unread counts to the same edge", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");

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
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Invalid response from /api/folders",
  );
  expect(state.treeRequests).toBe(1);
});

// The in-app prompt dialog (#698) replacing native prompt(): a successful
// create drives the same API call the native dialog used to.
test("creates a folder through the in-app prompt", async ({ page }) => {
  const state = await installApiFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "add folder" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await dialog.getByRole("textbox").fill("Saved");
  await dialog.getByRole("button", { name: "OK" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The fixture's POST /api/folders handler asserts the body is exactly
  // { name: "Saved" }, so reaching here without a console/request failure
  // proves the prompt value reached the API; the reload bumps the count.
  await expect.poll(() => state.treeRequests).toBe(2);
});

// Cancel must resolve exactly like the native cancel path: no delete, and
// focus back on the button that opened the dialog.
test("cancelling the delete confirmation keeps the source", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  await page.getByRole("button", { name: "delete source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Delete "Tech News"?');
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toBeVisible();
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
  await installApiFixture(page);
  await page.goto("/");

  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toBeVisible();
  await page.locator(".chevron").first().click();
  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toBeHidden();
});

test("preserves an unauthenticated deep link through login", async ({
  page,
}) => {
  await installApiFixture(page, { authenticated: false });
  const next = "/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml";
  await page.goto(next);

  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe(next);
  // The initial GET /api/folders 401 that drives this redirect is expected
  // -- not a bug -- so clear it rather than let afterEach's zero-console-
  // errors guard fail on it, matching the pattern used below for the
  // other test that deliberately triggers an expired-session 401.
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

// A folder's <ul role="group"> is a DOM sibling of its treeitem, so nothing
// but this aria-owns keeps the two connected -- lose it and the nesting
// silently flattens in the accessibility tree while looking identical.
test("hangs a folder's nested group off its own treeitem", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");

  const folder = page.locator(".source.folder").first();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  const owns = await folder.getAttribute("aria-owns");
  expect(owns).toBeTruthy();
  await expect(page.locator(`#${owns}`)).toHaveAttribute("role", "group");
});

test("narrows the tree to what matches, and says so when nothing does", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");

  const filter = page.getByLabel("Filter feeds");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();

  await filter.fill("tech");
  // The folder does not match "tech" itself; it survives through its child.
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();

  await filter.fill("nothing matches this");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toHaveCount(
    0,
  );
  await expect(page.getByText("No feeds match that.")).toBeVisible();

  await filter.fill("");
  await expect(page.getByRole("treeitem", { name: /Tech News/ })).toBeVisible();
});

// The article list is keyset-paged and the scroll position is what asks for
// the next page, so a list too short to scroll can never ask. Deleting a whole
// page is the way in: select all, delete, and the pane would sit empty with
// pages still unread and nothing left to scroll.
test("fetches the next article page after a delete empties the list", async ({
  page,
}) => {
  await installApiFixture(page);
  const pageSize = 200;
  const cursors: (number | undefined)[] = [];
  // Registered after the fixture, so it wins for this one route and falls
  // through to the fixture for every other request the page makes.
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = route.request().postDataJSON();
    cursors.push(body.cursor);
    const start = body.cursor === undefined ? 1 : pageSize + 1;
    const size = body.cursor === undefined ? pageSize : 3;
    await route.fulfill({
      json: Array.from({ length: size }, (_, index) =>
        pagedSummary(start + index),
      ),
    });
  });
  // Selecting the list also opens its first row, and these ids are not ones
  // the fixture knows.
  await page.route("**/api/article?*", async (route) => {
    const id = Number(
      new URL(route.request().url()).searchParams.get("article"),
    );
    await route.fulfill({
      json: {
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
      },
    });
  });
  await page.goto("/");
  await selectSource(page);

  const rows = page.locator(".article-list .article");
  await expect(rows).toHaveCount(pageSize);
  expect(cursors).toEqual([undefined]);

  await page.getByRole("button", { exact: true, name: "select all" }).click();
  await page.getByRole("button", { name: "delete articles" }).click();

  // The second page arrives without a scroll, because there was nothing left
  // to scroll, and it is asked for with the last row of the first page.
  await expect(rows).toHaveCount(3);
  expect(cursors).toEqual([undefined, pageSize]);
});

// Today is scoped by `view`, not by an id list, and its tree row's uid is the
// string "today" rather than a source id. The second page has to be asked for
// the same way the first one was: running that uid through sourceIds gives
// [NaN], which serialises to [null] and the server refuses the request.
test("pages the Today view with the view, not its node uid", async ({
  page,
}) => {
  await installApiFixture(page);
  const pageSize = 200;
  const bodies: { cursor?: number; sources: number[]; view?: string }[] = [];
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    const body = route.request().postDataJSON();
    bodies.push(body);
    const start = body.cursor === undefined ? 1 : pageSize + 1;
    const size = body.cursor === undefined ? pageSize : 3;
    await route.fulfill({
      json: Array.from({ length: size }, (_, index) =>
        pagedSummary(start + index),
      ),
    });
  });
  await page.route("**/api/article?*", async (route) => {
    const id = Number(
      new URL(route.request().url()).searchParams.get("article"),
    );
    await route.fulfill({
      json: {
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
      },
    });
  });
  await page.goto("/");
  await selectSource(page, "Today");

  const rows = page.locator(".article-list .article");
  await expect(rows).toHaveCount(pageSize);

  // Same emptying trick as the test above: nothing left to scroll is what
  // makes the app ask for the next page without a scroll gesture.
  await page.getByRole("button", { exact: true, name: "select all" }).click();
  await page.getByRole("button", { name: "delete articles" }).click();
  await expect(rows).toHaveCount(3);

  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toMatchObject({
    cursor: pageSize,
    sources: [],
    view: "today",
  });
});

// Read state is the alternative to the delete-as-you-read workflow: an
// article you are finished with but want to keep. Marking one read has to
// take it out of the Unread view without taking it out of the store.
test("marks an article read, moving it between the filters", async ({
  page,
}) => {
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  const filter = page.getByRole("combobox", { name: "Show" });
  await articleOptions(page).first().click();
  await page.getByRole("button", { name: "Mark read" }).click();

  // Gone from Unread, and the server was told rather than the row merely
  // hidden client-side.
  await expect(articleOptions(page)).toHaveCount(2);
  expect([...state.readArticleIds]).toEqual([11]);

  await filter.selectOption("read");
  await expect(articleOptions(page)).toHaveCount(1);
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);

  await filter.selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);
  // Only the one marked renders as read, from the server's own flag.
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);

  // The button offers the reverse action once the selection is already read.
  await articleOptions(page).first().click();
  await page.getByRole("button", { name: "Mark unread" }).click();
  await expect(page.locator(".article-list .article.read")).toHaveCount(0);
  expect([...state.readArticleIds]).toEqual([]);

  // Same action from the keyboard, which is how Delete already works.
  await articleOptions(page).first().click();
  await page.keyboard.press("m");
  await expect(page.locator(".article-list .article.read")).toHaveCount(1);
  expect([...state.readArticleIds]).toEqual([11]);

  // Three list requests, all of them a change of question: the initial
  // selection and the two filter changes. Marking read answers itself
  // locally -- re-asking would flash the skeleton over rows already correct.
  expect(state.articleRequests).toBe(3);
});

// The scroll-past policy (#714): rows held in view for the dwell time are
// marked read in ONE batched request, not one per article. The All view keeps
// rows in place, and the row open in the reader is excluded so nothing is
// pulled out from under the person reading it.
test("scroll-past policy batches dwelled rows into one PATCH", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("markReadPolicy", "on-scroll-past");
  });
  const state = await installApiFixture(page, { multipleArticles: true });
  // Short enough that the last rows start out of view and need scrolling to.
  await page.setViewportSize({ height: 320, width: 1280 });
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page)
    .last()
    .evaluate((row) => row.scrollIntoView());
  await expect
    .poll(() => state.readMarks, { timeout: 10_000 })
    .toEqual([[12, 13]]);

  // One request for both rows, and the rows render as read from the same
  // optimistic update the Mark read button uses.
  await expect(page.locator(".article-list .article.read")).toHaveCount(2);
  expect([...state.readArticleIds].toSorted((a, b) => a - b)).toEqual([12, 13]);
});

// Manual is the default policy: scrolling changes nothing, and no observer
// work happens at all.
test("default policy never marks read on scroll", async ({ page }) => {
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.setViewportSize({ height: 320, width: 1280 });
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("combobox", { name: "Show" }).selectOption("all");
  await expect(articleOptions(page)).toHaveCount(3);

  await articleOptions(page)
    .last()
    .evaluate((row) => row.scrollIntoView());
  await page.waitForTimeout(1500);

  expect(state.readMarks).toEqual([]);
  expect(state.readArticleIds.size).toBe(0);
});

test("the options page offers and persists the read-mark policy", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/options");

  const policy = page.getByRole("combobox", {
    name: "When articles get marked read",
  });
  await expect(policy).toHaveValue("manual");
  await expect(policy.locator("option")).toHaveCount(3);
  await expect(policy.locator("option[value=manual]")).toHaveText(
    /Manually only/,
  );
  await expect(policy.locator("option[value=on-open]")).toHaveText(/On open/);
  await expect(policy.locator("option[value=on-scroll-past]")).toHaveText(
    /scroll-past/,
  );

  await policy.selectOption("on-scroll-past");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "When articles get marked read" }),
  ).toHaveValue("on-scroll-past");
});

// Colour cannot carry this. forced-colors mode replaces every colour the
// stylesheet sets with the system palette, and a selected row already has to
// put a read title back to the selected text colour or it drops under 1.5:1.
// Weight survives both, which is what the tree already relies on for a source
// with unread articles.
test("tells read from unread by weight, not only colour", async ({ page }) => {
  await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
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

  // Still selected from the click above, which is the case colour cannot
  // answer at all.
  await expect(articleOptions(page).first()).toHaveClass(/selected/);
  const readWeight = await weightOf(0);
  expect(readWeight).not.toBe(unreadWeight);
  expect(Number(unreadWeight)).toBeGreaterThan(Number(readWeight));
});

// The tree is a roving tabindex: exactly one row carries tabindex="0" and the
// rest carry -1. A filter that removed the row holding it would leave none,
// and Tab would step straight past the whole tree.
test("keeps exactly one tree tab stop across filtering", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");
  const tabStops = page.locator('[role="treeitem"][tabindex="0"]');
  await expect(tabStops).toHaveCount(1);

  await page.getByLabel("Filter feeds").fill("tech");
  await expect(tabStops).toHaveCount(1);

  await page.getByLabel("Filter feeds").fill("");
  await expect(tabStops).toHaveCount(1);
});

// The route answers as it does for an unknown address when no mail is
// configured, so offering the link there would only send people somewhere
// that cannot help them.
test("offers a password reset link only where mail can deliver one", async ({
  page,
}) => {
  await installApiFixture(page, { authenticated: false });
  await page.goto("/login");
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

test("retitles the document on route changes", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");

  // The dashboard badges the title with the fixture's total unread count;
  // leaving the dashboard unmounts it and drops the badge again.
  await expect(page).toHaveTitle("(2) FeedFathom");
  await page.getByRole("button", { name: "options" }).first().click();
  await expect(page).toHaveTitle("Options · FeedFathom");
});

test("shows the current account and logs out", async ({ page }) => {
  const state = await installApiFixture(page);
  await page.goto("/options");

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
  await installApiFixture(page, { sessionFailure: true });
  await page.goto("/options");

  await expect(page.getByRole("alert")).toContainText(
    "Invalid response from /api/session",
  );
  expect(new URL(page.url()).pathname).toBe("/options");
});

test("loads articles and content from a selected source", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  const option = page.getByRole("option", { name: /First article/ });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "First article" }),
  ).toBeVisible();
  await expect(page.getByText("Feed article content")).toBeVisible();
});

test("select all moves focus into the list so Delete works immediately", async ({
  page,
}) => {
  // Regression test: clicking the toolbar's "select all" button natively
  // focuses the button itself, which sits outside .article-list -- the
  // element handleArticleKeys (Delete/arrow-key handling) is attached to.
  // Without moving focus back into the list, a Delete keypress right after
  // clicking select-all was silently a no-op.
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  await page.getByRole("button", { name: "select all" }).click();
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: /Second article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("option", { name: /Third article/ }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("role")),
  ).toBe("option");

  await page.keyboard.press("Delete");
  await expect(articleOptions(page)).toHaveCount(0);
  await expect
    .poll(() => state.removedArticleIds.toSorted((a, b) => a - b))
    .toEqual([11, 12, 13]);
});

test("select all does not scroll the article list", async ({ page }) => {
  // Regression test: focusArticleAt(0) used to always scrollIntoView the
  // first row, which yanked the list back to the top even when the user
  // had scrolled down before clicking select-all.
  await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
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
});

test("select all then clicking Delete removes every article", async ({
  page,
}) => {
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  await page.getByRole("button", { name: "select all" }).click();
  await page.getByRole("button", { name: "delete articles" }).click();

  await expect(articleOptions(page)).toHaveCount(0);
  await expect
    .poll(() => state.removedArticleIds.toSorted((a, b) => a - b))
    .toEqual([11, 12, 13]);
});

test("selecting a single article then pressing Delete removes only it", async ({
  page,
}) => {
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
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

test("disables the delete-articles button until something is selected", async ({
  page,
}) => {
  await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");

  const deleteButton = page.getByRole("button", { name: "delete articles" });
  await expect(deleteButton).toBeDisabled();

  // Selecting a source auto-selects its first article for immediate
  // reading (see "loads articles and content from a selected source"), so
  // the button already reflects a selection right after this.
  await selectSource(page);
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(deleteButton).toBeEnabled();
});

test("source properties reuses the discovery panel with feed/website locked", async ({
  page,
}) => {
  // Editing reuses the exact same left-pane form the "add source" flow
  // uses (see feed-discovery.tsx), just with feed/home URL disabled and
  // the website-search/preview steps hidden -- not a separate dialog.
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  await page.getByRole("button", { name: "source properties" }).click();

  await expect(page.getByRole("heading", { name: "Edit feed" })).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("Tech News");
  const website = page.getByLabel("Website");
  const feedUrl = page.getByLabel("Feed URL");
  await expect(website).toHaveValue("https://news.example/");
  await expect(website).toBeDisabled();
  await expect(feedUrl).toHaveValue("https://news.example/feed.xml");
  await expect(feedUrl).toBeDisabled();
  await expect(page.getByRole("button", { name: "Find feeds" })).toHaveCount(0);
});

test("renaming a source through the edit panel updates the tree", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await page.goto("/");
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
  const state = await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);
  await page.getByRole("button", { name: "source properties" }).click();

  await page.getByLabel("Title").fill("Should not save");
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("heading", { name: "Edit feed" })).toHaveCount(0);
  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toBeVisible();
  expect(state.updatedSource).toBeUndefined();
});

test("deletes a source after confirmation and refreshes the tree", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  await page.getByRole("button", { name: "delete source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "OK" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toHaveCount(0);
  expect(state.removedSourceIds).toEqual([3]);
});

test("renaming a folder through properties updates the tree", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await page.goto("/");
  await page
    .locator("button.source.folder")
    .filter({ hasText: "Reading" })
    .click();

  await page.getByRole("button", { name: "source properties" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The rename prompt opens pre-filled with the current name (#698).
  await expect(dialog.getByRole("textbox")).toHaveValue("Reading");
  await dialog.getByRole("textbox").fill("Archive");
  await dialog.getByRole("button", { name: "OK" }).click();

  await expect(
    page.locator("button.source.folder").filter({ hasText: "Archive" }),
  ).toBeVisible();
  expect(state.updatedFolder).toEqual({ name: "Archive" });
});

test("blocks deleting a non-empty folder", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");
  await page
    .locator("button.source.folder")
    .filter({ hasText: "Reading" })
    .click();

  await page.getByRole("button", { name: "delete source" }).click();

  // No confirmation dialog may open for a non-empty folder (#698 moved the
  // confirm in-app, so absence is directly assertable).
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Folder is not empty");
  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toBeVisible();
});

test("every toolbar icon renders and is clickable", async ({ page }) => {
  // Regression test for the Icon component swap (inline currentColor SVG
  // instead of <img src>) -- each button must still have a nonzero hit
  // area and a visible icon, not just an empty/invisible span.
  await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
  await selectSource(page);

  const toolbarButtons = [
    "add source",
    "add folder",
    "source properties",
    "delete source",
    "select all",
    "delete articles",
  ];
  await Promise.all(
    toolbarButtons.map(async (name) => {
      const button = page.getByRole("button", { exact: true, name }).first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
      await expect(button.locator("svg")).toBeVisible();
    }),
  );
});

test("shows the generic RSS icon for a source with no favicon", async ({
  page,
}) => {
  // Regression test for the favicon <Show>/faviconFailed restructuring:
  // the fixture's source carries favicon: null, so this exercises the
  // Icon-swap fallback branch (not the real <img>) on every render.
  await installApiFixture(page);
  await page.goto("/");

  const nodeIcon = page
    .locator("button.source")
    .filter({ hasText: "Tech News" })
    .locator(".node-icon");
  await expect(nodeIcon.locator("svg")).toBeVisible();
  await expect(nodeIcon.locator("img")).toHaveCount(0);
});

test("uses three desktop panes and mobile history navigation", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");

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

test("validates Website URLs before discovery", async ({ page }) => {
  const state = await installApiFixture(page);
  await page.goto("/preview");
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
  await installApiFixture(page, { websubFeed: true });
  await page.goto("/preview");
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
  await installApiFixture(page, { discoveryRace: true });
  await page.goto("/preview");
  await page.getByLabel("Website").fill("https://preview.example/");
  await page.getByRole("button", { name: "Find feeds" }).click();

  await page.getByRole("button", { name: /Slow feed/ }).click();
  await page.getByRole("button", { name: /Fast feed/ }).click();

  await expect(page.getByLabel("Title")).toHaveValue("Fast feed");
  await page.waitForTimeout(250);
  await expect(page.getByLabel("Title")).toHaveValue("Fast feed");
  await expect(
    page.getByRole("heading", { name: "Fast feed article" }),
  ).toBeVisible();
});

test("keeps preview usable when folder startup fails", async ({ page }) => {
  await installApiFixture(page, { foldersFailure: true });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml");

  await expect(page.getByLabel("Title")).toHaveValue("Tech Preview");
  await expect(page.getByRole("alert")).toContainText(
    "Invalid response from /api/folders",
  );
});

test("previews and subscribes with the exact payload", async ({ page }) => {
  const state = await installApiFixture(page);
  await page.goto("/preview?feedUrl=https%3A%2F%2Fpreview.example%2Ffeed.xml");

  await expect(page.getByLabel("Title")).toHaveValue("Tech Preview");
  await expect(page.getByLabel("Folder")).toContainText("Reading");
  await expect(
    page.getByRole("heading", { name: "Preview article" }),
  ).toBeVisible();

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

test("exposes Reader modes only when the bridge is available", async ({
  context,
  page,
}) => {
  await installReaderResponder(context, true);
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  const modes = page.getByRole("combobox", { name: "Article display mode" });
  await expect(modes).toContainText("Reader (plain text)");
  await modes.selectOption("READABILITY");
  await expect(
    page.getByText("Reader bridge content.", { exact: false }),
  ).toBeVisible();
});

test("extracts article content with the alternate extractor", async ({
  context,
  page,
}) => {
  await installReaderResponder(context, true);
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  await page
    .getByRole("combobox", { name: "Article display mode" })
    .selectOption("ARTICLE_EXTRACTOR");
  await expect(
    page.getByText("Reader bridge content.", { exact: false }),
  ).toBeVisible();
});

test("keeps Feed mode when the Reader bridge is unavailable", async ({
  page,
}) => {
  await installReaderResponder(page.context(), false);
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  await expect(
    page.getByRole("combobox", { name: "Article display mode" }),
  ).toHaveCount(0);
  await expect(page.getByText("Feed article content")).toBeVisible();
});

test("redirects expired protected requests to login", async ({ page }) => {
  const state = await installApiFixture(page);
  await page.goto("/");
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

test("surfaces tree failures without masquerading as logout", async ({
  page,
}) => {
  await installApiFixture(page, { treeFailure: true });
  await page.goto("/");

  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByRole("alert")).toContainText(
    "Invalid response from /api/tree",
  );
  await expect(page.getByRole("button", { name: "Login" })).toHaveCount(0);
});

// The #709 keyboard vocabulary: j/k alias the arrow keys' selection movement,
// which already opens the article in the reader pane; ? opens the cheat sheet
// hosted in the shared DialogHost.
test("j and k move the selection like the arrow keys", async ({ page }) => {
  await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
  await selectSource(page);
  await expect(articleOptions(page)).toHaveCount(3);

  // Selecting a source lands the cursor on the first article.
  await articleOptions(page).first().focus();
  await expect(articleOptions(page).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("j");
  await expect(
    page.getByRole("option", { name: /Second article/ }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-index"),
    ),
  ).toBe("1");

  await page.keyboard.press("k");
  await expect(
    page.getByRole("option", { name: /First article/ }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-index"),
    ),
  ).toBe("0");
});

test("? opens the shortcut help dialog and Escape closes it", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);
  await articleOptions(page).first().focus();

  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await expect(dialog.getByText("Mark read / unread")).toBeVisible();

  // Esc dismisses, and focus returns to the article row that invoked it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("role")),
  ).toBe("option");
});

test("the options page can open the shortcut help dialog without a keyboard", async ({
  page,
}) => {
  await installApiFixture(page);
  await page.goto("/options");

  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
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
  await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
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
  // The selection stays on the row, and focus stays in the input: the
  // keydown was text, not a command.
  await expect(articleOptions(page).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("j");
});

// Session restoration (#718). Each spec scrolls with real scroll events and
// waits out the 500ms write throttle once -- everything after that is the
// app's own state machine, no timers.
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
    await page.waitForTimeout(700);

    await page.reload();
    // The restored selection re-opens the article in the reader pane and
    // puts the list back at the stored offset -- all from one boot fetch.
    await expect(page.locator(".reader h1")).toHaveText("Article 130");
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(500);
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

    // select() opens the first row automatically.
    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    const reader = page.locator(".reader");
    const halfScroll = await reader.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.5;
      return element.scrollTop;
    });
    expect(halfScroll).toBeGreaterThan(200);
    await page.waitForTimeout(700);

    await page.reload();
    await expect(page.locator(".reader h1")).toHaveText("First article");
    await expect
      .poll(() => reader.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(200);
  });

  test("with the preference off, no snapshot is written and nothing restores", async ({
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
    await reader.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.5;
    });
    await page.waitForTimeout(700);

    await page.reload();
    await selectSource(page);
    await expect(page.locator(".reader h1")).toHaveText("First article");
    // No snapshot ever existed, so the article opens at the top.
    await expect
      .poll(() => reader.evaluate((element) => element.scrollTop))
      .toBe(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("feedfathom:reading-session:v1"),
      ),
    ).toBeNull();
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

    // The node is gone: the snapshot is dropped silently and the ordinary
    // empty boot path takes over -- no error, no broken pane.
    await expect(page.getByText("Select a feed to read.")).toBeVisible();
    await expect(page.locator(".dashboard-alert")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("feedfathom:reading-session:v1"),
      ),
    ).toBeNull();
  });
});
