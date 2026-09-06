import { storedInstance } from "#shared/extension-types.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

void (async () => {
  const storedValue =
    storedInstance(await chrome.storage.sync.get("instance")) ?? "";
  const instanceInput = document.querySelector("#instance");
  if (!(instanceInput instanceof HTMLInputElement)) {
    return;
  }
  const instanceError = document.querySelector("#instance-error");

  let displayedValue = canonicalizeInstance(storedValue) ?? storedValue;
  instanceInput.value = displayedValue;

  // An inline message rather than alert(): a browser can offer to suppress
  // repeat dialogs, and once it does the field just silently reverts to the
  // old value with nothing said. It also names the rule, which "bad URL" did
  // not -- plain http being loopback-only is the rejection people hit.
  const rejectionMessage =
    "Enter the full address of your FeedFathom instance, such as " +
    "https://feeds.example.com. Plain http:// is accepted only for localhost.";
  const showError = (message: string) => {
    if (instanceError) instanceError.textContent = message;
  };

  instanceInput.addEventListener("change", () => {
    void (async () => {
      showError("");
      const value = instanceInput.value;
      if (value.trim() === "") {
        await chrome.storage.sync.remove("instance");
        displayedValue = "";
        instanceInput.value = displayedValue;
        return;
      }

      const canonicalInstance = canonicalizeInstance(value);
      if (!canonicalInstance) {
        showError(rejectionMessage);
        instanceInput.value = displayedValue;
        return;
      }

      await chrome.storage.sync.set({ instance: canonicalInstance });
      displayedValue = canonicalInstance;
      instanceInput.value = displayedValue;
    })();
  });
})();
