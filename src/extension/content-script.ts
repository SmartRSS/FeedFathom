import { scan } from "../lib/scanner.ts";
import type { FeedData } from "../lib/scanners/feed-data-type.ts";

(() => {
  // Define Timer type missing in the codebase
  type Timer = ReturnType<typeof setTimeout>;

  // Constants for timeout durations
  const visibilityDebounceMs = 500;
  const scanDebounceMs = 1_500;

  const oldHref = document.location.href;
  let scanTimeoutRef: null | Timer = null;
  let visibilityTimeoutRef: null | Timer = null;
  let mutationObserver: MutationObserver | null = null;

  // Debounce utility function
  const debounce = <T extends (feedsData: FeedData[]) => void>(
    function_: T,
    delay: number,
  ): ((feedsData: FeedData[]) => void) => {
    let timeoutId: null | Timer = null;

    return (feedsData: FeedData[]) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      timeoutId = setTimeout(() => {
        function_(feedsData);
      }, delay);
    };
  };

  const updateAvailableSourcesList = (feedsData: FeedData[]) => {
    if (document.hidden) {
      try {
        void chrome.runtime.sendMessage({ action: "visibility-lost" });
      } catch {
        // nop
      }

      return;
    }

    if (visibilityTimeoutRef) {
      clearTimeout(visibilityTimeoutRef);
      visibilityTimeoutRef = null;
    }

    visibilityTimeoutRef = setTimeout(() => {
      try {
        void chrome.runtime.sendMessage({
          action: "list-feeds",
          feedsData,
        });
      } catch {}

      visibilityTimeoutRef = null;
    }, visibilityDebounceMs);
  };

  // Create a debounced version for event handlers
  const debouncedUpdateSourcesList = debounce(
    updateAvailableSourcesList,
    visibilityDebounceMs,
  );

  const setupEventListeners = (feedsData: FeedData[]) => {
    document.addEventListener(
      "visibilitychange",
      () => {
        debouncedUpdateSourcesList(feedsData);
      },
      false,
    );

    document.addEventListener(
      "pagehide",
      () => {
        debouncedUpdateSourcesList(feedsData);
      },
      false,
    );
  };

  const isYouTubeDomain = (url: string) => {
    return new URL(url).hostname.endsWith("youtube.com");
  };

  const setupMutationObserver = (currentHref: string) => {
    const bodyList = document.querySelector("body");

    if (!bodyList) {
      return;
    }

    // Clean up existing observer if any
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    mutationObserver = new MutationObserver(() => {
      if (currentHref === document.location.href) {
        return;
      }

      const newHref = document.location.href;

      if (scanTimeoutRef) {
        clearTimeout(scanTimeoutRef);
        scanTimeoutRef = null;
      }

      scanTimeoutRef = setTimeout(() => {
        (async () => {
          try {
            const updatedFeedsData = await scan(newHref, document);
            updateAvailableSourcesList(updatedFeedsData);
          } catch {}
        })();

        scanTimeoutRef = null;
      }, scanDebounceMs);
    });

    const observerConfig = {
      childList: true,
      subtree: true,
    };

    mutationObserver.observe(bodyList, observerConfig);
  };

  // Cleanup function to remove listeners and observers
  const cleanup = () => {
    if (scanTimeoutRef) {
      clearTimeout(scanTimeoutRef);
      scanTimeoutRef = null;
    }

    if (visibilityTimeoutRef) {
      clearTimeout(visibilityTimeoutRef);
      visibilityTimeoutRef = null;
    }

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  };

  // Add unload listener for cleanup
  window.addEventListener("unload", cleanup);

  // Additionally, listen for history API navigation events
  window.addEventListener("popstate", () => {
    if (oldHref !== document.location.href) {
      void (async () => {
        try {
          const feedsData = await scan(document.location.href, document);
          updateAvailableSourcesList(feedsData);
        } catch {}
      })();
    }
  });

  const init = async (currentHref: string) => {
    try {
      const feedsData = await scan(currentHref, document);
      setupEventListeners(feedsData);

      if (isYouTubeDomain(currentHref)) {
        setupMutationObserver(currentHref);
      }

      updateAvailableSourcesList(feedsData);
    } catch {}
  };

  void init(oldHref);
})();
