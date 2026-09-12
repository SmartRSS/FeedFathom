import { storedBadgeEnabled, storedInstance } from "#shared/extension-types.ts";
import { pingInstance } from "./instance.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

// Every listener is attached before the first await. Reading storage is a
// round trip to the extension process, and `load` fires the moment this
// script starts, not when that read lands -- so a change arriving in between
// used to reach no listener at all and be dropped in silence. The stored
// values are filled in afterwards.
void (async () => {
  const instanceInput = document.querySelector("#instance");
  if (!(instanceInput instanceof HTMLInputElement)) {
    return;
  }
  const instanceError = document.querySelector("#instance-error");

  let displayedValue = "";

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
  const connectionStatus = document.querySelector("#connection-status");
  const showStatus = (message: string) => {
    if (connectionStatus) connectionStatus.textContent = message;
  };
  const testButton = document.querySelector("#test-connection");

  testButton?.addEventListener("click", () => {
    void (async () => {
      if (
        !(testButton instanceof HTMLButtonElement) ||
        !connectionStatus ||
        !instanceError
      )
        return;
      const value = instanceInput.value.trim();
      if (value === "") {
        showStatus("Enter an instance address to test first.");
        return;
      }
      const candidate = canonicalizeInstance(value);
      if (!candidate) {
        showError(rejectionMessage);
        return;
      }

      testButton.disabled = true;
      showStatus("Checking…");
      const reachable = await pingInstance(candidate);
      testButton.disabled = false;
      showStatus(
        reachable
          ? `Connected to ${candidate}.`
          : `Could not reach ${candidate}. Check the address and that the instance is running.`,
      );
    })();
  });

  instanceInput.addEventListener("change", () => {
    void (async () => {
      showError("");
      showStatus("");
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

  // The badge toggle (#768): checked state straight from storage so the
  // page is honest even before any change, and every change persisted
  // immediately -- the background clears live badges as the key flips off.
  const badgeToggle = document.querySelector("#show-badge");
  if (badgeToggle instanceof HTMLInputElement) {
    badgeToggle.addEventListener("change", () => {
      void chrome.storage.sync.set({ showBadge: badgeToggle.checked });
    });
  }

  const storedValue =
    storedInstance(await chrome.storage.sync.get("instance")) ?? "";
  displayedValue = canonicalizeInstance(storedValue) ?? storedValue;
  instanceInput.value = displayedValue;
  if (badgeToggle instanceof HTMLInputElement) {
    badgeToggle.checked = storedBadgeEnabled(
      await chrome.storage.sync.get("showBadge"),
    );
  }
})();
