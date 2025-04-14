import { ulid } from "ulid";
import type { Message } from "./extension-types.ts";
import type { FeedData } from "../lib/scanners/feed-data-type.ts";

// ===== URL Validation Functions =====

/**
 * Validates that a string is a valid URL and contains only the origin
 * (no path, query parameters, or hash fragments)
 *
 * @param urlString The URL string to validate
 * @returns true if valid origin-only URL, false otherwise
 */
const isValidOrigin = (urlString: string): boolean => {
  // First check if it's a valid URL
  if (!URL.canParse(urlString)) {
    return false;
  }

  try {
    const url = new URL(urlString);
    // Check if URL contains only origin (no path, query, or hash)
    return (
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    // Fallback for environments where URL.canParse isn't available
    return false;
  }
};

// ===== Storage Utilities =====

/**
 * Gets the configured instance URL from storage
 * @returns The instance URL or null if not configured
 */
const getInstanceUrl = async (): Promise<null | string> => {
  try {
    const instanceObject = await chrome.storage.sync.get("instance");
    if (typeof instanceObject["instance"] !== "string") {
      return null;
    }

    return instanceObject["instance"];
  } catch {
    return null;
  }
};

// ===== Menu Management =====

// Menu state variables
let clearMenusRequested = false;
let isMenuUpdateInProgress = false;
let menuUpdateTimer: null | number = null;
let pendingFeedsData: FeedData[] | null = null;
const debounceTime = 300;

// Menu state management functions
const startMenuUpdate = (): void => {
  isMenuUpdateInProgress = true;
};

const finishMenuUpdate = (): void => {
  isMenuUpdateInProgress = false;
};

const setPendingFeeds = (feeds: FeedData[]): void => {
  pendingFeedsData = feeds;
};

const requestMenuClear = (): void => {
  clearMenusRequested = true;
  // Cancel any pending feeds
  pendingFeedsData = null;
};

const markClearProcessed = (): void => {
  clearMenusRequested = false;
};

const hasPendingFeeds = (): boolean => {
  return pendingFeedsData !== null;
};

const consumePendingFeeds = (): FeedData[] | null => {
  const feeds = pendingFeedsData;
  pendingFeedsData = null;
  return feeds;
};

/**
 * Creates context menu items with proper error handling and race condition prevention
 * @param feedsData Feed data to display in context menu
 */
const updateContextMenus = async (feedsData: FeedData[]): Promise<void> => {
  // If update already in progress, store for later and exit
  if (isMenuUpdateInProgress) {
    setPendingFeeds(feedsData);
    return;
  }

  startMenuUpdate();

  try {
    // Clean up existing menus first
    await chrome.contextMenus.removeAll();

    // If clear was requested, honor it and exit
    if (clearMenusRequested) {
      markClearProcessed();
      return;
    }

    // Create parent menu items
    await Promise.all([
      chrome.contextMenus.create({
        contexts: ["action"],
        id: "FeedFathom_newsletter",
        title: "newsletter",
      }),
      chrome.contextMenus.create({
        contexts: ["action"],
        id: "FeedFathom",
        title: "Subscribe",
      }),
    ]);

    // Check again if clear was requested during parent menu creation
    if (clearMenusRequested) {
      await chrome.contextMenus.removeAll();
      markClearProcessed();
      return;
    }

    // Create child menu items
    const menuPromises = feedsData.map((feed) => {
      return chrome.contextMenus.create({
        contexts: ["action"],
        id: feed.url,
        parentId: "FeedFathom",
        title: feed.title,
      });
    });

    await Promise.all(menuPromises);
  } catch {
    // Silent error handling - menu creation failures shouldn't break functionality
  } finally {
    finishMenuUpdate();

    // Handle any state changes that occurred during update
    if (clearMenusRequested) {
      void chrome.contextMenus.removeAll();
      markClearProcessed();
    } else if (hasPendingFeeds()) {
      const pendingFeeds = consumePendingFeeds();
      if (pendingFeeds) {
        void updateContextMenus(pendingFeeds);
      }
    }
  }
};

// ===== Feed Preview Functionality =====

const feedSchemaExpression = /^feed:/iu;

/**
 * Opens a preview of the specified feed in a new tab
 * @param address The feed address to preview
 */
const previewSource = async (address: string): Promise<void> => {
  const instance = await getInstanceUrl();
  if (!instance) {
    return;
  }

  const fixedAddress = address.replace(feedSchemaExpression, "https:");
  void chrome.tabs.create({
    url: new URL(`/preview?feedUrl=${fixedAddress}`, instance).href,
  });
};

/**
 * Handles a newsletter subscription by generating a unique email address
 * @param instanceUrl The instance URL to use for the newsletter email
 */
const handleNewsletterSubscription = async (
  instanceUrl: string,
): Promise<void> => {
  const uuid = ulid();
  const email = instanceUrl.replace("https://", `${uuid}@`);
  await navigator.clipboard.writeText(email);
  await previewSource(email);
};

/**
 * Handles a feed subscription
 * @param feedUrl The feed URL to subscribe to
 * @param instanceUrl The instance URL to use for subscription
 */
const handleFeedSubscription = async (
  feedUrl: string,
  instanceUrl: string,
): Promise<void> => {
  if (!instanceUrl) {
    await navigator.clipboard.writeText(feedUrl);
    return;
  }

  await previewSource(feedUrl);
};

// ===== Event Handlers =====

/**
 * Handles context menu item clicks
 */
chrome.contextMenus.onClicked.addListener((info) => {
  (async () => {
    const instance = await getInstanceUrl();
    if (!instance) {
      return;
    }

    if (info.menuItemId === "FeedFathom_newsletter") {
      await handleNewsletterSubscription(instance);
      return;
    }

    if (info.menuItemId !== "FeedFathom") {
      await handleFeedSubscription(info.menuItemId as string, instance);
    }
  })();
});

/**
 * Handles messages from content scripts
 */
const messageHandler = (
  message: Message,
  _sender: chrome.runtime.MessageSender,
  _sendResponse: () => void,
): boolean => {
  if (message.action === "list-feeds") {
    // Debounce menu updates
    if (menuUpdateTimer) {
      clearTimeout(menuUpdateTimer);
    }

    menuUpdateTimer = setTimeout(() => {
      void updateContextMenus(message.feedsData);
      menuUpdateTimer = null;
    }, debounceTime) as unknown as number;
  }

  if (message.action === "visibility-lost") {
    // Cancel any pending updates
    if (menuUpdateTimer) {
      clearTimeout(menuUpdateTimer);
      menuUpdateTimer = null;
    }

    if (isMenuUpdateInProgress) {
      requestMenuClear();
    } else {
      void chrome.contextMenus.removeAll();
    }
  }

  return false;
};

chrome.runtime.onMessage.addListener(messageHandler);

/**
 * Handles clicks on the browser action (extension icon)
 */
chrome.action.onClicked.addListener(() => {
  (async () => {
    const instance = await getInstanceUrl();
    if (!(instance && isValidOrigin(instance))) {
      await chrome.runtime.openOptionsPage();
      return;
    }

    void chrome.tabs.create({
      active: true,
      url: instance,
    });
  })();
});
