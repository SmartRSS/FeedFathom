import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { openTarget } from "./instance.ts";
import { isListFeedsMessage, scanRequestMessage } from "./messages.ts";
import { readFoundFeeds } from "./settings.ts";
import type { OpenTarget } from "./url-helpers.ts";

const openAndClose = async (target: OpenTarget): Promise<void> => {
  await openTarget(target);
  window.close();
};

const requestLiveFeeds = (): Promise<FeedData[] | undefined> =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        resolve(undefined);
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        scanRequestMessage,
        (response: unknown) => {
          resolve(
            !chrome.runtime.lastError && isListFeedsMessage(response)
              ? response.feedsData
              : undefined,
          );
        },
      );
    });
  });

const renderFeeds = (container: Element, feeds: FeedData[]) => {
  if (feeds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-pane";
    empty.textContent = "No feeds found on this page.";
    container.append(empty);
    return;
  }
  container.className = "found-feeds";
  for (const feed of feeds) {
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = feed.title;
    const url = document.createElement("span");
    url.textContent = feed.url;
    button.append(title, url);
    button.addEventListener("click", () => {
      void openAndClose({ feedUrl: feed.url });
    });
    container.append(button);
  }
};

document.querySelector("#newsletter")?.addEventListener("click", () => {
  void openAndClose("newsletter");
});
document.querySelector("#open-dashboard")?.addEventListener("click", () => {
  void openAndClose("dashboard");
});

void (async () => {
  const feedsContainer = document.querySelector("#feeds");
  if (!feedsContainer) return;
  const feeds = (await requestLiveFeeds()) ?? (await readFoundFeeds()) ?? [];
  renderFeeds(feedsContainer, feeds);
})();
