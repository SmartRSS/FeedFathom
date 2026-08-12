import { scan } from "../lib/scanner.ts";
import type { FeedData } from "../lib/scanners/feed-data-type.ts";
import {
  isReaderRequest,
  isReaderResponseForRequest,
  readerErrorResponse,
} from "./extension-types.ts";

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
  let mutationObserver: MutationObserver | null = null;
  let disposed = false;

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
      const feeds = scan(href, document);
      if (
        disposed ||
        generation !== scanGeneration ||
        href !== document.location.href
      )
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
    mutationObserver = new MutationObserver(rescanIfHrefChanged);
    mutationObserver.observe(body, { childList: true, subtree: true });
  };

  const init = () => {
    currentHref = document.location.href;
    const generation = ++scanGeneration;
    setupMutationObserver();
    void scanPage(currentHref, generation);
  };

  const cleanup = () => {
    disposed = true;
    scanGeneration++;
    window.removeEventListener("message", readerMessage);
    window.removeEventListener("pagehide", updateAvailableSourcesList);
    window.removeEventListener("popstate", rescanIfHrefChanged);
    window.removeEventListener("hashchange", rescanIfHrefChanged);
    window.removeEventListener("unload", cleanup);
    document.removeEventListener(
      "visibilitychange",
      updateAvailableSourcesList,
    );
    document.removeEventListener("DOMContentLoaded", init);
    if (scanTimeoutRef) clearTimeout(scanTimeoutRef);
    if (visibilityTimeoutRef) clearTimeout(visibilityTimeoutRef);
    mutationObserver?.disconnect();
  };

  window.addEventListener("message", readerMessage);
  window.addEventListener("pagehide", updateAvailableSourcesList);
  window.addEventListener("popstate", rescanIfHrefChanged);
  window.addEventListener("hashchange", rescanIfHrefChanged);
  window.addEventListener("unload", cleanup);
  document.addEventListener("visibilitychange", updateAvailableSourcesList);

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
