import { storedInstance } from "./extension-types.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

void (async () => {
  const storedValue =
    storedInstance(await chrome.storage.sync.get("instance")) ?? "";
  const instanceInput = document.querySelector("#instance");
  if (!(instanceInput instanceof HTMLInputElement)) {
    return;
  }

  let displayedValue = canonicalizeInstance(storedValue) ?? storedValue;
  instanceInput.value = displayedValue;

  instanceInput.addEventListener("change", () => {
    void (async () => {
      const value = instanceInput.value;
      if (value.trim() === "") {
        await chrome.storage.sync.remove("instance");
        displayedValue = "";
        instanceInput.value = displayedValue;
        return;
      }

      const canonicalInstance = canonicalizeInstance(value);
      if (!canonicalInstance) {
        alert("bad URL");
        instanceInput.value = displayedValue;
        return;
      }

      await chrome.storage.sync.set({ instance: canonicalInstance });
      displayedValue = canonicalInstance;
      instanceInput.value = displayedValue;
    })();
  });
})();
