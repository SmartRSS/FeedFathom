import { scan } from "#shared/scanners/scanner.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import {
  isReaderRequest,
  isReaderResponseForRequest,
  isScanRequestMessage,
  readerErrorResponse,
  storedOpenRssEnabled,
} from "#shared/extension-types.ts";

const scanDocument = async (href: string) => {
  let openRss = false;
  try {
    openRss = storedOpenRssEnabled(
      await chrome.storage.sync.get("showOpenRss"),
    );
  } catch {}
  return scan(href, document, openRss);
};

// The mobile popup fallback (no contextMenus) can't wait out the on-load
// scan's debounce, so it asks for a fresh scan directly instead of trusting
// the background's cached copy.
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (!isScanRequestMessage(message)) return false;
    void scanDocument(document.location.href).then((feedsData) =>
      sendResponse({ action: "list-feeds", feedsData }),
    );
    return true;
  },
);

const readerMessage = (event: MessageEvent<unknown>) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    !isReaderRequest(event.data)
  )
    return;

  const request = event.data;
  const unavailable = () =>
    window.postMessage(
      readerErrorResponse(request, "UNAVAILABLE"),
      location.origin,
    );

  try {
    chrome.runtime.sendMessage(request, (response: unknown) => {
      if (chrome.runtime.lastError) {
        unavailable();
        return;
      }
      window.postMessage(
        isReaderResponseForRequest(response, request)
          ? response
          : readerErrorResponse(request, "UNAVAILABLE"),
        location.origin,
      );
    });
  } catch {
    unavailable();
  }
};

(() => {
  type Timer = ReturnType<typeof setTimeout>;

  const visibilityDebounceMs = 500;
  const scanDebounceMs = 1_500;

  let currentHref = document.location.href;
  let latestFeeds: FeedData[] = [];
  let scanGeneration = 0;
  let scanTimeoutRef: null | Timer = null;
  let visibilityTimeoutRef: null | Timer = null;

  const updateAvailableSourcesList = () => {
    if (visibilityTimeoutRef) clearTimeout(visibilityTimeoutRef);

    if (document.hidden) {
      try {
        void chrome.runtime.sendMessage({ action: "visibility-lost" });
      } catch {}
      visibilityTimeoutRef = null;
      return;
    }

    visibilityTimeoutRef = setTimeout(() => {
      try {
        void chrome.runtime.sendMessage({
          action: "list-feeds",
          feedsData: latestFeeds,
        });
      } catch {}
      visibilityTimeoutRef = null;
    }, visibilityDebounceMs);
  };

  const scanPage = async (href: string, generation: number) => {
    try {
      const feeds = await scanDocument(href);
      if (generation !== scanGeneration || href !== document.location.href)
        return;
      latestFeeds = feeds;
      updateAvailableSourcesList();
    } catch {}
  };

  const rescanIfHrefChanged = () => {
    const href = document.location.href;
    if (href === currentHref) return;

    currentHref = href;
    latestFeeds = [];
    const generation = ++scanGeneration;
    updateAvailableSourcesList();
    if (scanTimeoutRef) clearTimeout(scanTimeoutRef);
    scanTimeoutRef = setTimeout(() => {
      scanTimeoutRef = null;
      void scanPage(href, generation);
    }, scanDebounceMs);
  };

  const setupMutationObserver = () => {
    const body = document.body;
    if (!body) return;
    new MutationObserver(rescanIfHrefChanged).observe(body, {
      childList: true,
      subtree: true,
    });
  };

  const init = () => {
    currentHref = document.location.href;
    const generation = ++scanGeneration;
    setupMutationObserver();
    void scanPage(currentHref, generation);
  };

  window.addEventListener("message", readerMessage);
  window.addEventListener("pagehide", updateAvailableSourcesList);
  window.addEventListener("popstate", rescanIfHrefChanged);
  window.addEventListener("hashchange", rescanIfHrefChanged);
  document.addEventListener("visibilitychange", updateAvailableSourcesList);

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
