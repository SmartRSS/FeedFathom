import type { FeedData } from "./types";
import { scan } from "$lib/scanner";

(function () {
  const oldHref = document.location.href;
  let scanTimeoutRef: Timer | null = null;
  let visibilityTimeoutRef: Timer | null = null;

  async function init(currentHref: string) {
    const feedsData = await scan(currentHref, document);
    setupEventListeners(feedsData);
    if (isYouTubeDomain(currentHref)) {
      setupMutationObserver(feedsData, currentHref);
    }
    updateAvailableSourcesList(feedsData);
  }

  function setupEventListeners(feedsData: FeedData[]) {
    document.addEventListener(
      "visibilitychange",
      () => updateAvailableSourcesList(feedsData),
      false,
    );
    document.addEventListener(
      "pagehide",
      () => updateAvailableSourcesList(feedsData),
      false,
    );
  }

  function isYouTubeDomain(url: string): boolean {
    return new URL(url).hostname.endsWith("youtube.com");
  }

  function setupMutationObserver(feedsData: FeedData[], currentHref: string) {
    const bodyList = document.querySelector("body");
    if (!bodyList) {
      return;
    }
    const mutationObserver = new MutationObserver(() => {
      if (currentHref === document.location.href) {
        return;
      }
      const newHref = document.location.href;
      if (scanTimeoutRef) {
        clearTimeout(scanTimeoutRef);
      }
      scanTimeoutRef = setTimeout(async () => {
        await scan(newHref, document);
        updateAvailableSourcesList(feedsData);
      }, 1500);
    });

    const observerConfig = {
      childList: true,
      subtree: true,
    };
    mutationObserver.observe(bodyList, observerConfig);
  }

  function updateAvailableSourcesList(feedsData: FeedData[]) {
    if (document.hidden) {
      void browser.runtime.sendMessage({ action: "visibility-lost" });
      return;
    }
    if (visibilityTimeoutRef) {
      clearTimeout(visibilityTimeoutRef);
    }

    visibilityTimeoutRef = setTimeout(() => {
      void browser.runtime.sendMessage({
        action: "list-feeds",
        feedsData: feedsData,
      });
    }, 500);
  }

  void init(oldHref);
})();
