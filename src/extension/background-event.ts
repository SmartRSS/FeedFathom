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

const getInstanceUrl = async (): Promise<null | string> => {
  try {
    const instance = storedInstance(await chrome.storage.sync.get("instance"));
    return instance ? (canonicalizeInstance(instance) ?? null) : null;
  } catch {
    return null;
  }
};

// Undefined when the instance is old, unreachable, or ingests no mail; the
// address then falls back to the instance hostname.
const getMailDomain = async (instance: string): Promise<string | undefined> => {
  try {
    const response = await fetch(new URL("/api/session", instance).href, {
      credentials: "include",
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const domain =
      typeof body === "object" && body !== null && "mailDomain" in body
        ? body.mailDomain
        : undefined;
    return typeof domain === "string" ? domain : undefined;
  } catch {
    return undefined;
  }
};

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

const previewSource = (instance: string, address: string): void => {
  const previewUrl = buildPreviewUrl(instance, address);
  if (previewUrl) {
    void chrome.tabs.create({ url: previewUrl });
  }
};

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
    if (menuUpdateTimer) {
      clearTimeout(menuUpdateTimer);
    }

    menuUpdateTimer = setTimeout(() => {
      void updateContextMenus(message.feedsData);
      menuUpdateTimer = null;
    }, debounceTime);
  }

  if (isVisibilityLostMessage(message)) {
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
