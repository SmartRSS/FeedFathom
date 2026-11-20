import { expect, test } from "@playwright/test";

test("executes the production SPA and loads its assets", async ({ page }) => {
  const browserFailures: string[] = [];
  const loadedAssets: string[] = [];
  page.on("pageerror", (error) => browserFailures.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Failed to load resource")
    )
      browserFailures.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (["document", "script", "stylesheet"].includes(request.resourceType()))
      browserFailures.push(`request failed: ${request.url()}`);
  });
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (type === "script" || type === "stylesheet") {
      if (response.ok()) loadedAssets.push(response.url());
      else
        browserFailures.push(
          `response ${response.status()}: ${response.url()}`,
        );
    } else if (type === "document" && !response.ok()) {
      browserFailures.push(`response ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto("/");
  await expect(page.locator("#app")).not.toBeEmpty();
  await expect(
    page.getByRole("button", { name: "Login" }).or(page.locator(".dashboard")),
  ).toBeVisible();
  expect(loadedAssets.length).toBeGreaterThan(0);
  expect(browserFailures).toEqual([]);
});
