<script lang="ts">
import { browser } from "$app/environment";
import { onMount } from "svelte";

onMount(() => {
  if (browser && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/service-worker.js");
  }
});
</script>

<slot />
