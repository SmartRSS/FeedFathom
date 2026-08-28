import { describe, expect, test } from "bun:test";
import {
  createContextMenu,
  type ContextMenuOperations,
  removeAllContextMenus,
  type RuntimeErrors,
} from "../context-menu.ts";

class ContextMenusFake implements ContextMenuOperations {
  readonly calls: string[] = [];
  readonly callbacks: Array<() => void> = [];

  create(
    properties: chrome.contextMenus.CreateProperties,
    callback: () => void,
  ): number | string {
    this.calls.push(`create:${properties.id}`);
    this.callbacks.push(callback);
    return properties.id ?? this.calls.length;
  }

  removeAll(callback: () => void): void {
    this.calls.push("removeAll");
    this.callbacks.push(callback);
  }

  completeNext(): void {
    const callback = this.callbacks.shift();
    if (!callback) throw new Error("No pending context-menu operation");
    callback();
  }
}

const menu = (id: string): chrome.contextMenus.CreateProperties => ({
  id,
  title: id,
});

describe("context-menu callbacks", () => {
  test("settles only after the browser callback", async () => {
    const operations = new ContextMenusFake();
    let settled = false;
    const pending = createContextMenu(menu("parent"), operations, {}).then(
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    operations.completeNext();
    await pending;
    expect(settled).toBe(true);
  });

  test("rejects runtime errors observed inside the callback", async () => {
    const operations = new ContextMenusFake();
    const runtime: RuntimeErrors = { lastError: { message: "duplicate id" } };
    const pending = removeAllContextMenus(operations, runtime);

    operations.completeNext();
    await expect(pending).rejects.toThrow("duplicate id");
  });

  test("supports remove, parent, then child ordering", async () => {
    const operations = new ContextMenusFake();
    const update = (async () => {
      await removeAllContextMenus(operations, {});
      await createContextMenu(menu("parent"), operations, {});
      await createContextMenu(menu("child"), operations, {});
    })();

    expect(operations.calls).toEqual(["removeAll"]);
    operations.completeNext();
    await Promise.resolve();
    expect(operations.calls).toEqual(["removeAll", "create:parent"]);
    operations.completeNext();
    await Promise.resolve();
    expect(operations.calls).toEqual([
      "removeAll",
      "create:parent",
      "create:child",
    ]);
    operations.completeNext();
    await update;
  });
});
