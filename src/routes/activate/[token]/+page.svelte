<script lang="ts">
  import { page } from "$app/stores";

  let loading = false;
  let error: string | null = null;
  let success = false;

  async function activate() {
    loading = true;
    error = null;
    success = false;

    const response = await fetch($page.url.href, {
      method: "POST",
    });

    const result = (await response.json()) as { error?: string };

    if (response.ok) {
      success = true;
    } else {
      error = result.error || "An unknown error occurred.";
    }

    loading = false;
  }
</script>

<h1>Activate Your Account</h1>

{#if success}
  <p>Your account has been activated! You can now log in.</p>
{:else if error}
  <p>{error}</p>
{:else}
  <p>Click the button below to activate your account.</p>
  <button on:click={activate} disabled={loading}>
    {loading ? "Activating..." : "Activate"}
  </button>
{/if}
