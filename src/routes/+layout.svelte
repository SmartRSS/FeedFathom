<script lang="ts">
import { onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let updateAvailable = false;
let registration: ServiceWorkerRegistration | undefined;

onMount(() => {
  if (typeof window !== "undefined") {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        void navigator.serviceWorker
          .register("/service-worker.js")
          .then((reg) => {
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
      }
    });
  }
});

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
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
