import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import {
  isListFeedsMessage,
  isReaderRequest,
  isVisibilityLostMessage,
  storedInstance,
  type ReaderResponse,
} from "#shared/extension-types.ts";
import { createContextMenu, removeAllContextMenus } from "./context-menu.ts";
import { handleReaderRequest } from "./reader-fetch.ts";
import {
  buildNewsletterAddress,
  buildPreviewUrl,
  canonicalizeInstance,
  normalizeFeedAddress,
} from "./url-helpers.ts";

// ===== Storage Utilities =====

/**
 * Gets the configured instance URL from storage
 * @returns The instance URL or null if not configured
 */
const getInstanceUrl = async (): Promise<null | string> => {
  try {
    const instance = storedInstance(await chrome.storage.sync.get("instance"));
    return instance ? (canonicalizeInstance(instance) ?? null) : null;
  } catch {
    return null;
  }
};

// ===== Menu Management =====

// Menu state variables
let clearMenusRequested = false;
let isMenuUpdateInProgress = false;
let menuUpdateTimer: null | ReturnType<typeof setTimeout> = null;
let pendingFeedsData: FeedData[] | null = null;
const debounceTime = 300;

/**
 * Creates context menu items with proper error handling and race condition prevention
 * @param feedsData Feed data to display in context menu
 */
const updateContextMenus = async (feedsData: FeedData[]): Promise<void> => {
  // If update already in progress, store for later and exit
  if (isMenuUpdateInProgress) {
    pendingFeedsData = feedsData;
    return;
  }

  isMenuUpdateInProgress = true;

  try {
    // Clean up existing menus first
    await removeAllContextMenus();

    // If clear was requested, honor it and exit
    if (clearMenusRequested) {
      clearMenusRequested = false;
      return;
    }

    // Create parent menu items
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

    // Check again if clear was requested during parent menu creation
    if (clearMenusRequested) {
      await removeAllContextMenus();
      clearMenusRequested = false;
      return;
    }

    // Create child menu items. chrome.contextMenus.create() rejects on a
    // duplicate id, and feed.url is used as the id -- a page listing the
    // same feed URL twice would otherwise silently drop that menu entry
    // when its create() call rejects.
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
    // Silent error handling - menu creation failures shouldn't break functionality
  } finally {
    if (clearMenusRequested) {
      try {
        await removeAllContextMenus();
      } catch {}
      clearMenusRequested = false;
    }

    isMenuUpdateInProgress = false;

    // Handle any state changes that occurred during update
    if (pendingFeedsData !== null) {
      const pendingFeeds = pendingFeedsData;
      pendingFeedsData = null;
      void updateContextMenus(pendingFeeds);
    }
  }
};

// ===== Feed Preview Functionality =====

/**
 * Opens a preview of the specified feed in a new tab
 * @param instance The FeedFathom instance origin
 * @param address The feed address to preview
 */
const previewSource = (instance: string, address: string): void => {
  const previewUrl = buildPreviewUrl(instance, address);
  if (previewUrl) {
    void chrome.tabs.create({ url: previewUrl });
  }
};

// ===== Event Handlers =====

/**
 * Handles context menu item clicks
 */
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
      );
      if (address) previewSource(instance, address);
      return;
    }

    const feedUrl =
      typeof info.menuItemId === "string"
        ? info.menuItemId
        : info.menuItemId.toString();
    if (instance) previewSource(instance, feedUrl);
    else void chrome.tabs.create({ url: normalizeFeedAddress(feedUrl) });
  })();
});

/**
 * Handles messages from content scripts
 */
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
    // Debounce menu updates
    if (menuUpdateTimer) {
      clearTimeout(menuUpdateTimer);
    }

    menuUpdateTimer = setTimeout(() => {
      void updateContextMenus(message.feedsData);
      menuUpdateTimer = null;
    }, debounceTime);
  }

  if (isVisibilityLostMessage(message)) {
    // Cancel any pending updates
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

  return false;
};

chrome.runtime.onMessage.addListener(messageHandler);

/**
 * Handles clicks on the browser action (extension icon)
 */
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
