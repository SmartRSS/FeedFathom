import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import {
  isListFeedsMessage,
  isReaderRequest,
  isVisibilityLostMessage,
  type ReaderResponse,
} from "#shared/extension-types.ts";
import { createContextMenu, removeAllContextMenus } from "./context-menu.ts";
import { getInstanceUrl, getMailDomain } from "./instance.ts";
import { handleReaderRequest } from "./reader-fetch.ts";
import { buildNewsletterAddress, resolveFeedOpenUrl } from "./url-helpers.ts";

// Firefox for Android has no contextMenus API at all: touching it throws
// synchronously, which would otherwise abort this whole script (including
// the runtime.onMessage listener the reader bridge depends on) before it
// finishes loading. Where it's missing, the toolbar icon opens popup.html
// instead so subscribing is still possible without a right-click menu.
const hasContextMenus = Boolean(chrome.contextMenus);
if (!hasContextMenus) {
  void chrome.action.setPopup({ popup: "popup.html" });
}

let clearMenusRequested = false;
let isMenuUpdateInProgress = false;
let menuUpdateTimer: null | ReturnType<typeof setTimeout> = null;
let pendingFeedsData: FeedData[] | null = null;
const debounceTime = 300;

const updateContextMenus = async (feedsData: FeedData[]): Promise<void> => {
  if (isMenuUpdateInProgress) {
    pendingFeedsData = feedsData;
    return;
  }

  isMenuUpdateInProgress = true;

  try {
    await removeAllContextMenus();

    if (clearMenusRequested) {
      clearMenusRequested = false;
      return;
    }

    await Promise.all([
      createContextMenu({
        contexts: ["action"],
        id: "FeedFathom_newsletter",
        title: "newsletter",
      }),
      createContextMenu({
        contexts: ["action"],
        id: "FeedFathom",
        title: "Subscribe",
      }),
    ]);

    // A clear may have been requested while the parents were being created.
    if (clearMenusRequested) {
      await removeAllContextMenus();
      clearMenusRequested = false;
      return;
    }

    // create() rejects on a duplicate id and feed.url is the id, so a page
    // listing the same feed twice would silently drop that entry.
    const uniqueFeedsData = [
      ...new Map(feedsData.map((feed) => [feed.url, feed])).values(),
    ];
    await Promise.all(
      uniqueFeedsData.map((feed) =>
        createContextMenu({
          contexts: ["action"],
          id: feed.url,
          parentId: "FeedFathom",
          title: feed.title,
        }),
      ),
    );
  } catch {
    // A failed menu must not break the rest of the extension.
  } finally {
    if (clearMenusRequested) {
      try {
        await removeAllContextMenus();
      } catch {}
      clearMenusRequested = false;
    }

    isMenuUpdateInProgress = false;

    if (pendingFeedsData !== null) {
      const pendingFeeds = pendingFeedsData;
      pendingFeedsData = null;
      void updateContextMenus(pendingFeeds);
    }
  }
};

if (hasContextMenus) {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === "FeedFathom") {
      return;
    }

    void (async () => {
      const instance = await getInstanceUrl();

      if (info.menuItemId === "FeedFathom_newsletter") {
        if (!instance) {
          await chrome.runtime.openOptionsPage();
          return;
        }

        const address = buildNewsletterAddress(
          instance,
          globalThis.crypto.randomUUID(),
          await getMailDomain(instance),
        );
        if (address)
          void chrome.tabs.create({
            url: resolveFeedOpenUrl(instance, address),
          });
        return;
      }

      const feedUrl =
        typeof info.menuItemId === "string"
          ? info.menuItemId
          : info.menuItemId.toString();
      void chrome.tabs.create({ url: resolveFeedOpenUrl(instance, feedUrl) });
    })();
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
    void chrome.storage.session.set({ feedsData: message.feedsData });

    if (hasContextMenus) {
      if (menuUpdateTimer) {
        clearTimeout(menuUpdateTimer);
      }

      menuUpdateTimer = setTimeout(() => {
        void updateContextMenus(message.feedsData);
        menuUpdateTimer = null;
      }, debounceTime);
    }
  }

  if (isVisibilityLostMessage(message)) {
    void chrome.storage.session.remove("feedsData");

    if (hasContextMenus) {
      if (menuUpdateTimer) {
        clearTimeout(menuUpdateTimer);
        menuUpdateTimer = null;
      }

      if (isMenuUpdateInProgress) {
        clearMenusRequested = true;
        pendingFeedsData = null;
      } else {
        void removeAllContextMenus().catch(() => {});
      }
    }
  }

  return false;
};

chrome.runtime.onMessage.addListener(messageHandler);

chrome.action.onClicked.addListener(() => {
  void (async () => {
    const instance = await getInstanceUrl();
    if (!instance) {
      await chrome.runtime.openOptionsPage();
      return;
    }

    void chrome.tabs.create({
      active: true,
      url: instance,
    });
  })();
});
