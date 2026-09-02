import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { isListFeedsMessage } from "#shared/extension-types.ts";
import { getInstanceUrl, getMailDomain } from "./instance.ts";
import { buildNewsletterAddress, resolveFeedOpenUrl } from "./url-helpers.ts";

// Stands in for the desktop right-click "Subscribe" menu on browsers with no
// contextMenus API (Firefox for Android): background-event.ts sets this as
// the toolbar icon's popup only when that API is unavailable.
const openAndClose = (url: string): void => {
  void chrome.tabs.create({ url });
  window.close();
};

// Desktop's context menu can afford to wait for content-script.ts's on-load
// scan (debounced, pushed to the background). The popup can't -- it's
// opened on demand, often before that debounce fires -- so it asks the
// active tab's content script to scan right now instead. Falls back to the
// cached copy (below) when there's no content script to ask, e.g. this
// popup was opened directly rather than via the toolbar icon, or the page
// is one content scripts can't run on.
const requestLiveFeeds = (): Promise<FeedData[] | null> =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { action: "scan-request" },
        (response: unknown) => {
          resolve(
            !chrome.runtime.lastError && isListFeedsMessage(response)
              ? response.feedsData
              : null,
          );
        },
      );
    });
  });

void (async () => {
  const [liveFeeds, { feedsData: cachedFeeds }, instance] = await Promise.all([
    requestLiveFeeds(),
    chrome.storage.session.get<{ feedsData?: FeedData[] }>("feedsData"),
    getInstanceUrl(),
  ]);

  const feedsContainer = document.querySelector("#feeds");
  if (feedsContainer) {
    const feeds = liveFeeds ?? cachedFeeds ?? [];
    if (feeds.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-pane";
      empty.textContent = "No feeds found on this page.";
      feedsContainer.append(empty);
    } else {
      feedsContainer.className = "found-feeds";
      for (const feed of feeds) {
        const button = document.createElement("button");
        button.type = "button";
        // Title over URL, as the dashboard's feed discovery list renders it:
        // a site whose feeds share a long title prefix is otherwise three
        // identically-clipped rows.
        const title = document.createElement("strong");
        title.textContent = feed.title;
        const url = document.createElement("span");
        url.textContent = feed.url;
        button.append(title, url);
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
