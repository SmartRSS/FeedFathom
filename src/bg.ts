import { type Message } from "./extensionTypes";
import { ulid } from "ulid";

const previewSource = async (address: string) => {
  const instanceObject = await browser.storage.sync.get("instance");
  if (typeof instanceObject["instance"] !== "string") {
    return;
  }

  const instance = instanceObject["instance"];
  const fixedAddress = address.replace(/^feed:/iu, "https:");
  void browser.tabs.create({
    url: new URL(`/preview?feedUrl=${fixedAddress}`, instance).href,
  });
};

browser.contextMenus.onClicked.addListener((info) => {
  (async () => {
    const instanceObject = await browser.storage.sync.get("instance");
    if (typeof instanceObject["instance"] !== "string") {
      return;
    }

    const instance = instanceObject["instance"];

    if (info.menuItemId === "FeedFathom_newsletter") {
      const uuid = ulid();
      const email = instance.replace("https://", `${uuid}@`);
      await navigator.clipboard.writeText(email);
      await previewSource(email);
      return;
    }

    if (info.menuItemId !== "FeedFathom") {
      if (!instance) {
        await navigator.clipboard.writeText(info.menuItemId as string);
        return;
      }

      await previewSource(info.menuItemId as string);
    }
  })();
});

const messageHandler = (message: Message) => {
  if (message.action === "list-feeds") {
    void browser.contextMenus.removeAll();
    browser.contextMenus.create({
      contexts: ["action"],
      id: "FeedFathom_newsletter",
      title: "newsletter",
    });
    browser.contextMenus.create(
      {
        contexts: ["action"],
        id: "FeedFathom",
        title: "Subscribe",
      },
      () => {
        for (const feed of message.feedsData) {
          browser.contextMenus.create({
            contexts: ["action"],
            id: feed.url,
            parentId: "FeedFathom",
            title: feed.title,
          });
        }
      },
    );
  }

  if (message.action === "visibility-lost") {
    void browser.contextMenus.removeAll();
  }
};

browser.runtime.onMessage.addListener(messageHandler);

browser.action.onClicked.addListener(() => {
  (async () => {
    const instanceObject = await browser.storage.sync.get("instance");
    if (typeof instanceObject["instance"] !== "string") {
      return;
    }

    const instance = instanceObject["instance"];
    if (!instance) {
      await browser.runtime.openOptionsPage();
      return;
    }

    void browser.tabs.create({
      active: true,
      url: instance,
    });
  })();
});
