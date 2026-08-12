export type ContextMenuOperations = {
  create(
    properties: chrome.contextMenus.CreateProperties,
    callback: () => void,
  ): number | string;
  removeAll(callback: () => void): void;
};

export type RuntimeErrors = {
  readonly lastError?: { message?: string } | undefined;
};

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

export const createContextMenu = (
  properties: chrome.contextMenus.CreateProperties,
  operations: ContextMenuOperations = chrome.contextMenus,
  runtime: RuntimeErrors = chrome.runtime,
): Promise<void> =>
  callbackPromise((callback) => {
    operations.create(properties, callback);
  }, runtime);

export const removeAllContextMenus = (
  operations: ContextMenuOperations = chrome.contextMenus,
  runtime: RuntimeErrors = chrome.runtime,
): Promise<void> =>
  callbackPromise((callback) => {
    operations.removeAll(callback);
  }, runtime);
