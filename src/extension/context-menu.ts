import type { MenuOperations } from "./menu-sync.ts";

type ContextMenusApi = {
  create(
    properties: chrome.contextMenus.CreateProperties,
    callback: () => void,
  ): number | string;
  removeAll(callback: () => void): void;
};

type RuntimeErrors = {
  readonly lastError?: { message?: string } | undefined;
};

// chrome.contextMenus reports failure only through runtime.lastError inside
// the callback, so each operation settles there.
const callbackPromise = (
  operation: (callback: () => void) => void,
  runtime: RuntimeErrors,
): Promise<void> =>
  new Promise((resolve, reject) => {
    operation(() => {
      const error = runtime.lastError;
      if (error)
        reject(new Error(error.message ?? "Extension operation failed"));
      else resolve();
    });
  });

export const contextMenuOperations = (
  api: ContextMenusApi,
  runtime: RuntimeErrors,
): MenuOperations => ({
  create: (properties) =>
    callbackPromise((callback) => {
      api.create(properties, callback);
    }, runtime),
  removeAll: () =>
    callbackPromise((callback) => api.removeAll(callback), runtime),
});
