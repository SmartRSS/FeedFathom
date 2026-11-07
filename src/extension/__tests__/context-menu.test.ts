import { describe, expect, test } from "bun:test";
import { contextMenuOperations } from "../context-menu.ts";

// Holds each browser callback until the test releases it, as the real API
// answers asynchronously.
class ContextMenusFake {
  readonly callbacks: Array<() => void> = [];

  create(
    properties: chrome.contextMenus.CreateProperties,
    callback: () => void,
  ): number | string {
    this.callbacks.push(callback);
    return properties.id ?? this.callbacks.length;
  }

  removeAll(callback: () => void): void {
    this.callbacks.push(callback);
  }

  completeNext(): void {
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("No pending context-menu operation");
    callback();
  }
}

describe("contextMenuOperations", () => {
  test("settles only after the browser callback", async () => {
    const api = new ContextMenusFake();
    let settled = false;
    const pending = contextMenuOperations(api, {})
      .create({ id: "parent", title: "parent" })
      .then(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    api.completeNext();
    await pending;
    expect(settled).toBe(true);
  });

  test("rejects runtime errors observed inside the callback", async () => {
    const api = new ContextMenusFake();
    const runtime = { lastError: { message: "duplicate id" } };
    const pending = contextMenuOperations(api, runtime).removeAll();

    api.completeNext();
    await expect(pending).rejects.toThrow("duplicate id");
  });
});
