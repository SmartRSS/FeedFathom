import { isReaderRequest, type ReaderResponse } from "#shared/reader-bridge.ts";
import { badgeColor, formatBadgeCount } from "./badge.ts";
import { contextMenuOperations } from "./context-menu.ts";
import { getInstanceUrl, openTarget } from "./instance.ts";
import {
  createMenuSync,
  newsletterMenuId,
  subscribeMenuId,
  timerSchedule,
} from "./menu-sync.ts";
import { isListFeedsMessage, isVisibilityLostMessage } from "./messages.ts";
import { handleReaderRequest } from "./reader-fetch.ts";
import {
  forgetFoundFeeds,
  onBadgeTurnedOff,
  readSettings,
  storeFoundFeeds,
} from "./settings.ts";

// Firefox for Android has no contextMenus API at all: touching it throws
// synchronously, which would otherwise abort this whole script (including
// the runtime.onMessage listener the reader bridge depends on) before it
// finishes loading. Where it's missing, the toolbar icon opens popup.html
// instead so subscribing is still possible without a right-click menu.
const hasContextMenus = Boolean(chrome.contextMenus);
if (!hasContextMenus) {
  void chrome.action.setPopup({ popup: "popup.html" });
}

// Content scripts can't touch chrome.action, so they report the found-feed
// count via the list-feeds / visibility-lost messages and the background
// keeps the per-tab badge honest. setBadgeText with a tabId is per-tab;
// without one it would stamp every tab with the last report.
const setTabBadge = (tabId: number, feedsFound: number): void => {
  void chrome.action.setBadgeText({
    tabId,
    text: formatBadgeCount(feedsFound),
  });
};
const clearTabBadge = (tabId: number): void => setTabBadge(tabId, 0);

// Guarded like contextMenus above: a synchronous throw here would stop the
// rest of this script, the reader bridge included, from loading.
try {
  void chrome.action.setBadgeBackgroundColor({ color: badgeColor });
} catch {}

// A navigation wipes whatever the previous page reported; the content script
// (run_at document_start) re-reports once its own debounced scan finishes.
// Only status is read here, which needs no "tabs" permission.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearTabBadge(tabId);
});

// Turning the badge off has to clear the badges already on screen: the
// content script re-reports only on its next scan, which may be never for a
// page left open. query() needs no "tabs" permission -- only reading a tab's
// url or title does -- and ids are filtered because some pseudo-tabs
// (devtools) have none.
onBadgeTurnedOff(() => {
  void (async () => {
    for (const tab of await chrome.tabs.query({}))
      if (tab.id !== undefined) clearTabBadge(tab.id);
  })();
});

const menuSync = hasContextMenus
  ? createMenuSync(
      contextMenuOperations(chrome.contextMenus, chrome.runtime),
      timerSchedule,
    )
  : undefined;

if (hasContextMenus) {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === subscribeMenuId) return;
    if (info.menuItemId === newsletterMenuId) {
      void openTarget("newsletter");
      return;
    }
    void openTarget({ feedUrl: String(info.menuItemId) });
  });
}

const projectReaderSender = (sender: chrome.runtime.MessageSender) => ({
  ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
  ...(sender.url === undefined ? {} : { url: sender.url }),
});

const messageHandler = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: ReaderResponse) => void,
): boolean => {
  if (isReaderRequest(message)) {
    void (async () => {
      const response = await handleReaderRequest(
        message,
        projectReaderSender(sender),
        await getInstanceUrl(),
      );
      sendResponse(response);
    })();
    return true;
  }

  if (isListFeedsMessage(message)) {
    // The popup fallback (no contextMenus) reads this directly, so it's
    // kept current independent of the menu update below.
    void storeFoundFeeds(message.feedsData);

    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      // With the badge setting off a report only clears whatever the page's
      // previous state left behind.
      void (async () => {
        if ((await readSettings()).showBadge)
          setTabBadge(tabId, message.feedsData.length);
        else clearTabBadge(tabId);
      })();
    }

    menuSync?.show(message.feedsData);
  }

  if (isVisibilityLostMessage(message)) {
    void forgetFoundFeeds();
    if (sender.tab?.id !== undefined) clearTabBadge(sender.tab.id);
    menuSync?.clear();
  }

  return false;
};

chrome.runtime.onMessage.addListener(messageHandler);

chrome.action.onClicked.addListener(() => {
  void openTarget("dashboard");
});
