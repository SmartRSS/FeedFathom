import { openRssSuggestion } from "#shared/scanners/scanner.ts";
import {
  isReaderRequest,
  isReaderResponseForRequest,
  readerErrorResponse,
} from "#shared/reader-bridge.ts";
import { scanDocument } from "./document-scanner.ts";
import { isScanRequestMessage, listFeedsMessage } from "./messages.ts";
import { timerSchedule } from "./menu-sync.ts";
import { createPageScanner } from "./page-scanner.ts";
import { readSettings } from "./settings.ts";

const scanWithFallback = async (href: string) => {
  const feeds = scanDocument(href, document);
  if (feeds.length > 0 || !(await readSettings()).showOpenRss) return feeds;
  return [openRssSuggestion(href)];
};

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if (!isScanRequestMessage(message)) return false;
    void scanWithFallback(document.location.href).then((feeds) =>
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
  scan: scanWithFallback,
  schedule: timerSchedule,
  send: (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
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
