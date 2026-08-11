import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";
import { installApiFixture } from "./api-fixture";

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

const selectSource = async (page: Page, name = "Tech News") => {
  await page.locator("button.source").filter({ hasText: name }).click();
};

test.beforeEach(async ({ page }) => {
  guardBrowser(page);
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page) ?? []).toEqual([]);
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

test("surfaces folder creation failures without refreshing the tree", async ({
  page,
}) => {
  const state = await installApiFixture(page, { folderCreateFailure: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  page.once("dialog", (dialog) => dialog.accept("Saved"));
  await page.getByRole("button", { name: "add folder" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Invalid response from /api/folders",
  );
  expect(state.treeRequests).toBe(1);
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
  await expect(page.getByRole("option")).toHaveCount(3);

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
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect
    .poll(() => state.removedArticleIds.toSorted((a, b) => a - b))
    .toEqual([11, 12, 13]);
});

test("select all then clicking Delete removes every article", async ({
  page,
}) => {
  const state = await installApiFixture(page, { multipleArticles: true });
  await page.goto("/");
  await selectSource(page);
  await expect(page.getByRole("option")).toHaveCount(3);

  await page.getByRole("button", { name: "select all" }).click();
  await page.getByRole("button", { name: "delete articles" }).click();

  await expect(page.getByRole("option")).toHaveCount(0);
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

  await expect(page.getByRole("option")).toHaveCount(2);
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
  await selectSource(page);

  const deleteButton = page.getByRole("button", { name: "delete articles" });
  await expect(deleteButton).toBeDisabled();

  await page.getByRole("option", { name: /First article/ }).click();
  await expect(deleteButton).toBeEnabled();
});

test("shows source properties in an alert", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  let alertText = "";
  page.once("dialog", (dialog) => {
    alertText = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "source properties" }).click();

  expect(alertText).toContain("Tech News");
  expect(alertText).toContain("https://news.example/feed.xml");
});

test("deletes a source after confirmation and refreshes the tree", async ({
  page,
}) => {
  const state = await installApiFixture(page);
  await page.goto("/");
  await selectSource(page);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "delete source" }).click();

  await expect(
    page.locator("button.source").filter({ hasText: "Tech News" }),
  ).toHaveCount(0);
  expect(state.removedSourceIds).toEqual([3]);
});

test("blocks deleting a non-empty folder", async ({ page }) => {
  await installApiFixture(page);
  await page.goto("/");
  await page
    .locator("button.source.folder")
    .filter({ hasText: "Reading" })
    .click();

  page.once("dialog", (dialog) => {
    throw new Error(`Unexpected confirm dialog: ${dialog.message()}`);
  });
  await page.getByRole("button", { name: "delete source" }).click();

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
      const button = page.getByRole("button", { name, exact: true }).first();
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

  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.setViewportSize({ width: 390, height: 844 });
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

  const modes = page.getByRole("combobox");
  await expect(modes).toContainText("Reader plain");
  await modes.selectOption("READABILITY");
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

  await expect(page.getByRole("combobox")).toHaveCount(0);
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
