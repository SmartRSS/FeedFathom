import { scan } from "$lib/scanner";
import { type FeedData } from "./types";

(function () {
  const oldHref = document.location.href;
  let scanTimeoutRef: null | Timer = null;
  let visibilityTimeoutRef: null | Timer = null;

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
      () => {return updateAvailableSourcesList(feedsData)},
      false,
    );
    document.addEventListener(
      "pagehide",
      () => {return updateAvailableSourcesList(feedsData)},
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
      }, 1_500);
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
        feedsData,
      });
    }, 500);
  }

  void init(oldHref);
})();
