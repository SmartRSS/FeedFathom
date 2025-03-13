<script lang="ts">
import { onMount } from "svelte";
import "../app.css";

let updateAvailable = false;
let isOffline = false;
let registration: ServiceWorkerRegistration | undefined;

onMount(() => {
  if (typeof window !== "undefined") {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/service-worker.js").then((reg) => {
          registration = reg;
        });
      });
    }

    // Listen for messages from the service worker
    navigator.serviceWorker?.addEventListener("message", (event) => {
      if (event.data.type === "VERSION_CHECK") {
        // Compare versions and show update notification if needed
        const currentVersion = localStorage.getItem("app_version");
        if (currentVersion && currentVersion !== event.data.version) {
          updateAvailable = true;
        }
        localStorage.setItem("app_version", event.data.version);
      } else if (event.data.type === "CONNECTION_STATUS") {
        isOffline = !event.data.isOnline;
      }
    });

    // Initial online status
    isOffline = !navigator.onLine;
  }
});

function updateServiceWorker() {
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
}
</script>

<slot />

{#if updateAvailable}
  <div class="fixed bottom-0 left-0 right-0 bg-primary text-white p-4 flex justify-between items-center">
    <span>A new version is available!</span>
    <button
      class="bg-white text-primary px-4 py-2 rounded"
      on:click={updateServiceWorker}
    >
      Update Now
    </button>
  </div>
{/if}

{#if isOffline}
  <div class="fixed top-0 left-0 right-0 bg-yellow-500 text-white p-2 text-center text-sm">
    You are currently offline. Some features may be limited.
  </div>
{/if}
