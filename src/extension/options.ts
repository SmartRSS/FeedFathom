import { pingInstance } from "./instance.ts";
import { clearInstance, readSettings, writeSettings } from "./settings.ts";
import { canonicalizeInstance } from "./url-helpers.ts";

void (async () => {
  const instanceInput = document.querySelector("#instance");
  if (!(instanceInput instanceof HTMLInputElement)) {
    return;
  }
  const instanceError = document.querySelector("#instance-error");

  let displayedValue = "";

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
        await clearInstance();
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

      await writeSettings({ instance: canonicalInstance });
      displayedValue = canonicalInstance;
      instanceInput.value = displayedValue;
    })();
  });

  const badgeToggle = document.querySelector("#show-badge");
  if (badgeToggle instanceof HTMLInputElement) {
    badgeToggle.addEventListener("change", () => {
      void writeSettings({ showBadge: badgeToggle.checked });
    });
  }

  const openRssToggle = document.querySelector("#show-openrss");
  if (openRssToggle instanceof HTMLInputElement) {
    openRssToggle.addEventListener("change", () => {
      void writeSettings({ showOpenRss: openRssToggle.checked });
    });
  }

  const settings = await readSettings();
  const storedValue = settings.instance ?? "";
  displayedValue = canonicalizeInstance(storedValue) ?? storedValue;
  instanceInput.value = displayedValue;
  if (badgeToggle instanceof HTMLInputElement)
    badgeToggle.checked = settings.showBadge;
  if (openRssToggle instanceof HTMLInputElement)
    openRssToggle.checked = settings.showOpenRss;
})();
