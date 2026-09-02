import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { getInstanceUrl, getMailDomain } from "./instance.ts";
import { buildNewsletterAddress, resolveFeedOpenUrl } from "./url-helpers.ts";

// Stands in for the desktop right-click "Subscribe" menu on browsers with no
// contextMenus API (Firefox for Android): background-event.ts sets this as
// the toolbar icon's popup only when that API is unavailable.
const openAndClose = (url: string): void => {
  void chrome.tabs.create({ url });
  window.close();
};

void (async () => {
  const [{ feedsData }, instance] = await Promise.all([
    chrome.storage.session.get<{ feedsData?: FeedData[] }>("feedsData"),
    getInstanceUrl(),
  ]);

  const feedsContainer = document.querySelector("#feeds");
  if (feedsContainer) {
    const feeds = feedsData ?? [];
    if (feeds.length === 0) {
      feedsContainer.textContent = "No feeds found on this page.";
    } else {
      for (const feed of feeds) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = feed.title;
        button.addEventListener("click", () => {
          openAndClose(resolveFeedOpenUrl(instance, feed.url));
        });
        feedsContainer.append(button);
      }
    }
  }

  document.querySelector("#newsletter")?.addEventListener("click", () => {
    void (async () => {
      if (!instance) {
        await chrome.runtime.openOptionsPage();
        window.close();
        return;
      }

      const address = buildNewsletterAddress(
        instance,
        globalThis.crypto.randomUUID(),
        await getMailDomain(instance),
      );
      if (address) openAndClose(resolveFeedOpenUrl(instance, address));
    })();
  });

  document.querySelector("#open-dashboard")?.addEventListener("click", () => {
    void (async () => {
      if (!instance) {
        await chrome.runtime.openOptionsPage();
        window.close();
        return;
      }

      openAndClose(instance);
    })();
  });
})();
