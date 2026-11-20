import { expect, test } from "./extension-fixture.ts";

test("mobile popup lists a cached feed and opens its preview URL", async ({
  baseURL,
  extension,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const { context, id: extensionId } = extension;
  const instance = new URL(baseURL).origin;

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  const input = optionsPage.getByLabel("Instance");

  await input.fill("http://feeds.example.com");
  await input.dispatchEvent("change");
  await expect(optionsPage.getByRole("alert")).toContainText(
    "only for localhost",
  );
  await expect(input).toHaveValue("");

  await input.fill(instance);
  await input.dispatchEvent("change");
  await expect(input).toHaveAccessibleDescription("");
  await optionsPage.waitForFunction(
    async (expected) =>
      (await chrome.storage.sync.get("instance"))["instance"] === expected,
    instance,
  );
  await optionsPage.evaluate(
    async () =>
      await chrome.storage.session.set({
        feedsData: [{ title: "Popup Feed", url: "https://feed.test/rss" }],
      }),
  );

  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const feedButton = popupPage.getByRole("button", { name: "Popup Feed" });
  await expect(feedButton).toBeVisible();
  await expect(feedButton).toContainText("https://feed.test/rss");
  await expect(feedButton).toHaveCSS("display", "grid");

  const [openedPage] = await Promise.all([
    context.waitForEvent("page"),
    feedButton.click(),
  ]);
  const openedUrl = new URL(openedPage.url());
  expect(openedUrl.origin).toBe(instance);
  expect(openedUrl.pathname).toBe("/preview");
  expect(openedUrl.searchParams.get("feedUrl")).toBe("https://feed.test/rss");
});

test("mobile popup scans the active tab live, ahead of the on-load cache", async ({
  baseURL,
  extension,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const { context, id: extensionId } = extension;

  const feedPage = await context.newPage();
  await feedPage.goto(baseURL);
  await feedPage.evaluate(() => {
    const link = document.createElement("link");
    link.rel = "alternate";
    link.type = "application/rss+xml";
    link.title = "Live Feed";
    link.href = "https://feed.test/live-rss";
    document.head.append(link);
  });

  const popupPage = await context.newPage();
  await feedPage.bringToFront();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

  const feedButton = popupPage.getByRole("button", { name: "Live Feed" });
  await expect(feedButton).toBeVisible();
});

test("mobile popup shows an empty state with no cached feeds", async ({
  extension,
}) => {
  const { context, id: extensionId } = extension;

  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    popupPage.getByText("No feeds found on this page."),
  ).toBeVisible();
});
