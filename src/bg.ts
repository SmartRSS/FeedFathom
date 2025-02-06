import { ulid } from "ulid";
import type { Message } from "./extensionTypes";

const previewSource = async (address: string) => {
  const instance = (await browser.storage.sync.get("instance"))["instance"];
  const fixedAddress = address.replace(/^feed:/i, "https:");
  void browser.tabs.create({
    url: new URL(`/preview?feedUrl=${fixedAddress}`, instance).href,
  });
};

browser.contextMenus.onClicked.addListener(async (info) => {
  const instance = (await browser.storage.sync.get("instance"))["instance"];

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
});

const messageHandler = (message: Message) => {
  if (message.action === "list-feeds") {
    void browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: "FeedFathom_newsletter",
      contexts: ["action"],
      title: "newsletter",
    });
    browser.contextMenus.create(
      {
        id: "FeedFathom",
        contexts: ["action"],
        title: "Subscribe",
      },
      function () {
        message.feedsData.forEach(function (feed) {
          browser.contextMenus.create({
            id: feed.url,
            title: feed.title,
            contexts: ["action"],
            parentId: "FeedFathom",
          });
        });
      },
    );
  }
  if (message.action === "visibility-lost") {
    void browser.contextMenus.removeAll();
  }
};

browser.runtime.onMessage.addListener(messageHandler);

browser.action.onClicked.addListener(async () => {
  const instance = (await browser.storage.sync.get("instance"))["instance"];
  if (!instance) {
    await browser.runtime.openOptionsPage();
    return;
  }
  void browser.tabs.create({
    active: true,
    url: instance,
  });
});
