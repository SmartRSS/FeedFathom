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

const hasContextMenus = Boolean(chrome.contextMenus);
if (!hasContextMenus) {
  void chrome.action.setPopup({ popup: "popup.html" });
}

const setTabBadge = (tabId: number, feedsFound: number): void => {
  void chrome.action.setBadgeText({
    tabId,
    text: formatBadgeCount(feedsFound),
  });
};
const clearTabBadge = (tabId: number): void => setTabBadge(tabId, 0);

try {
  void chrome.action.setBadgeBackgroundColor({ color: badgeColor });
} catch {}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearTabBadge(tabId);
});

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
    void storeFoundFeeds(message.feedsData);

    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
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
