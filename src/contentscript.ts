import { scan } from "$lib/scanner";
import { type FeedData } from "./types";

(function () {
  // Define Timer type missing in the codebase
  type Timer = ReturnType<typeof setTimeout>;

  // Constants for timeout durations
  const VISIBILITY_DEBOUNCE_MS = 500;
  const SCAN_DEBOUNCE_MS = 1_500;

  const oldHref = document.location.href;
  let scanTimeoutRef: null | Timer = null;
  let visibilityTimeoutRef: null | Timer = null;
  let mutationObserver: MutationObserver | null = null;

  // Debounce utility function
  const debounce = <T extends (feedsData: FeedData[]) => void>(
    function_: T,
    delay: number
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
        void browser.runtime.sendMessage({ action: "visibility-lost" });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error sending visibility-lost message:", error);
      }

      return;
    }

    if (visibilityTimeoutRef) {
      clearTimeout(visibilityTimeoutRef);
      visibilityTimeoutRef = null;
    }

    visibilityTimeoutRef = setTimeout(() => {
      try {
        void browser.runtime.sendMessage({
          action: "list-feeds",
          feedsData,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error sending list-feeds message:", error);
      }

      visibilityTimeoutRef = null;
    }, VISIBILITY_DEBOUNCE_MS);
  };

  // Create a debounced version for event handlers
  const debouncedUpdateSourcesList = debounce(updateAvailableSourcesList, VISIBILITY_DEBOUNCE_MS);

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

  const setupMutationObserver = (
    currentHref: string,
  ) => {
    const bodyList = document.querySelector("body");

    if (!bodyList) {
      // eslint-disable-next-line no-console
      console.warn("Body element not found, cannot setup MutationObserver");
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
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Error scanning page:", error);
          }
        })();

        scanTimeoutRef = null;
      }, SCAN_DEBOUNCE_MS);
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
  window.addEventListener('unload', cleanup);

  // Additionally, listen for history API navigation events
  window.addEventListener('popstate', () => {
    if (oldHref !== document.location.href) {
      void (async () => {
        try {
          const feedsData = await scan(document.location.href, document);
          updateAvailableSourcesList(feedsData);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("Error scanning page after navigation:", error);
        }
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
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error initializing content script:", error);
    }
  };

  void init(oldHref);
})();
