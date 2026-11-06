import { openRssSuggestion, scan } from "#shared/scanners/scanner.ts";
import {
  isReaderRequest,
  isReaderResponseForRequest,
  readerErrorResponse,
} from "#shared/reader-bridge.ts";
import { isScanRequestMessage, listFeedsMessage } from "./messages.ts";
import { createPageScanner } from "./page-scanner.ts";
import { readSettings } from "./settings.ts";

const scanDocument = async (href: string) => {
  const feeds = scan(href, document);
  if (feeds.length > 0 || !(await readSettings()).showOpenRss) return feeds;
  return [openRssSuggestion(href)];
};

// The mobile popup fallback (no contextMenus) can't wait out the on-load
// scan's debounce, so it asks for a fresh scan directly instead of trusting
// the background's cached copy.
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (!isScanRequestMessage(message)) return false;
    void scanDocument(document.location.href).then((feeds) =>
      sendResponse(listFeedsMessage(feeds)),
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

  // sendMessage throws once the extension is reloaded or removed under a
  // page that still runs this script; the page then sees UNAVAILABLE.
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

const pageScanner = createPageScanner({
  hidden: () => document.hidden,
  href: () => document.location.href,
  scan: scanDocument,
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
  send: (message) => {
    // Throws once the extension context is invalidated; the page has no one
    // left to report to.
    try {
      void chrome.runtime.sendMessage(message);
    } catch {}
  },
});

const start = () => {
  if (document.body)
    new MutationObserver(pageScanner.rescanIfHrefChanged).observe(
      document.body,
      { childList: true, subtree: true },
    );
  pageScanner.start();
};

window.addEventListener("message", readerMessage);
window.addEventListener("pagehide", pageScanner.report);
window.addEventListener("popstate", pageScanner.rescanIfHrefChanged);
window.addEventListener("hashchange", pageScanner.rescanIfHrefChanged);
document.addEventListener("visibilitychange", pageScanner.report);

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
