<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { onMount } from "svelte";
import { ulid } from "ulid";
import type { Folder } from "../../types/folder-type.ts";
import { logError } from "../../util/log.ts";

interface FoundFeed {
  url: string;
  title: string;
}

interface FeedPreview {
  title: string;
  description: string;
  link: string;
  feedUrl: string;
}

const { data } = $props();
const { isMailEnabled } = data;

let title = $state("");
let link = $state("");
let feedUrl = $state("");
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let isLoading = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let folders: Folder[] = $state([]);
// biome-ignore lint/style/useConst: bound by Svelte
let folder = $state("");
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let foundFeeds: FoundFeed[] = $state([]);
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let selectingFeed = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let errorMessage = $state("");
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let clipboardMessage = $state("");

onMount(async () => {
  feedUrl = page.url.searchParams.get("feedUrl") ?? "";
  link = page.url.searchParams.get("link") ?? "";

  const foldersResponse = await fetch("folders");
  if (foldersResponse.ok) {
    try {
      folders = (await foldersResponse.json()) as Folder[];
    } catch (jsonError) {
      logError("Failed to parseSource folders JSON:", jsonError);
      displayError("Failed to load folders.");
    }
  }

  if (!(feedUrl || link)) {
    return;
  }
  feedUrl ? await loadFeedPreview() : await findFeeds();
});

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const isFormFilled = $derived(title && link && feedUrl);
const mailLikeExpression = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    // Check if isMailEnabled is false and the URL looks like an email
    if (!isMailEnabled && mailLikeExpression.test(url)) {
      return false; // Invalid if it looks like an email
    }
    return true;
  } catch {
    return false;
  }
}

function displayError(message: string) {
  errorMessage = message;
  setTimeout(() => {
    errorMessage = "";
  }, 3000); // Clear after 3 seconds
}

function displayClipboardMessage(message: string) {
  clipboardMessage = message;
  setTimeout(() => {
    clipboardMessage = "";
  }, 3000); // Clear after 3 seconds
}

async function loadFeedPreview() {
  if (!isValidUrl(feedUrl)) {
    displayError("Invalid Feed URL");
    return;
  }

  // New validation for feedUrl against email format
  if (!isMailEnabled && mailLikeExpression.test(feedUrl)) {
    displayError("Feed URL cannot be an email when mail is not enabled");
    return;
  }

  try {
    isLoading = true;
    const response = await fetch(`/preview?feedUrl=${feedUrl}`);
    if (!response.ok) {
      throw new Error("Failed to load feed preview");
    }
    const data = (await response.json()) as FeedPreview;
    title = data.title;
    link = data.link;
    feedUrl = data.feedUrl;
  } catch (error) {
    logError("Error loading feed preview:", error);
    displayError("Failed to load feed preview.");
  } finally {
    isLoading = false;
  }
}

async function findFeeds() {
  if (!isValidUrl(link)) {
    displayError("Invalid Link URL");
    return;
  }

  isLoading = true;
  selectingFeed = true;

  try {
    const response = await fetch(`/find?link=${link}`);
    if (!response.ok) {
      throw new Error("Failed to find feeds");
    }
    foundFeeds = (await response.json()) as FoundFeed[];
  } catch (error) {
    logError("Error fetching feeds:", error);
    displayError("Failed to find feeds.");
  } finally {
    isLoading = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function selectFeed(selectedFeedUrl: string) {
  selectingFeed = false;
  feedUrl = selectedFeedUrl;
  foundFeeds = [];
  loadFeedPreview();
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
async function save() {
  const response = await fetch("subscribe", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sourceUrl: feedUrl,
      sourceName: title,
      sourceFolder: folder ? Number.parseInt(folder) : null,
    }),
  });

  if (response.ok) {
    await goto("/");
  } else {
    logError("Failed to subscribe to the feed.");
    displayError("Failed to subscribe to the feed.");
  }
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function cancel() {
  goto("/");
}

// Function to generate ULID email using current domain and copy to clipboard
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function generateAndCopyUlidEmail() {
  const currentDomain = window.location.hostname;
  const generatedUlid = ulid();
  const email = `${generatedUlid}@${currentDomain}`;
  feedUrl = email;
  link = email;

  // Copy to clipboard
  navigator.clipboard.writeText(email).then(
    () => {
      displayClipboardMessage("Email copied to clipboard!");
    },
    (e: unknown) => {
      logError("Failed to copy email:", e);
      displayError("Failed to copy email to clipboard.");
    },
  );
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function closeDialog() {
  selectingFeed = false;
  (document.getElementById("feed-dialog") as HTMLDialogElement)?.close();
}
</script>

<main>
  {#if errorMessage}
    <p class="error">{errorMessage}</p>
  {/if}

  {#if clipboardMessage}
    <div class="clipboard-message">{clipboardMessage}</div>
  {/if}

  <form onsubmit={save}>
    <fieldset>
      <legend>Feed Information</legend>
      <div class="input-block">
        <label for="title">Title:</label>
        <input bind:value={title} id="title" type="text" />
      </div>

      <div class="input-block">
        <label for="link">Link:</label>
        <input bind:value={link} id="link" type="text" />
      </div>

      <div class="input-block">
        <label for="feedUrl">Feed URL:</label>
        <input
          bind:value={feedUrl}
          id="feedUrl"
          type="text"
          pattern={isMailEnabled
            ? "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$|^(https?://.+)$"
            : "^(https?://.+)$"}
          title={isMailEnabled
            ? "Enter a valid email or feed URL."
            : "Enter a valid feed URL."}
        />
      </div>
    </fieldset>

    <fieldset>
      <legend>Folder</legend>
      <div class="input-block">
        <label for="folder">Folder:</label>
        <select bind:value={folder} name="folder">
          <option selected value="">-- no parent --</option>
          <hr />
          {#each folders as folder (folder.id)}
            <option value={folder.id}>{folder.name}</option>
          {/each}
        </select>
      </div>
    </fieldset>

    <div class="button-row">
      <button
        disabled={isLoading || !link || !isValidUrl(link)}
        onclick={findFeeds}
        type="button"
      >
        Find Feeds
      </button>
      <button
        disabled={isLoading || !feedUrl || !isValidUrl(feedUrl)}
        onclick={loadFeedPreview}
        type="button"
      >
        Load Preview
      </button>
      <button
        disabled={isLoading || !isMailEnabled}
        onclick={generateAndCopyUlidEmail}
        type="button"
        hidden={!isMailEnabled}
      >
        Generate and Copy ULID Email
      </button>
    </div>

    <div class="button-row">
      <button disabled={isLoading || !isFormFilled} type="submit">Save</button>
      <button disabled={isLoading} onclick={cancel} type="button"
        >Cancel
      </button>
    </div>
  </form>

  {#if selectingFeed}
    <dialog id="feed-dialog" class="modal">
      <div class="modal-content">
        <button class="close-button" onclick={() => closeDialog()}
          >&times;
        </button>
        <h3>Select a Feed</h3>
        {#if isLoading}
          <p>Loading...</p>
        {/if}
        {#each foundFeeds as feed (feed.url)}
          <div>
            <button type="button" onclick={() => selectFeed(feed.url)}>
              {feed.title} - {feed.url}
            </button>
          </div>
        {/each}
      </div>
    </dialog>
  {/if}
</main>

<style>
  main {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    padding: 20px;
  }

  form {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 768px;
    margin: auto;
    padding: 20px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background-color: white;
    position: relative; /* Ensure form content isn't shifted */
  }

  .input-block {
    margin-bottom: 15px;
  }

  .input-block label {
    font-weight: bold;
    margin-bottom: 5px;
    display: inline-block;
  }

  .input-block input,
  .input-block select {
    padding: 10px;
    width: calc(100% - 22px);
    border: 1px solid #ccc;
    border-radius: 4px;
  }
  input:user-invalid {
    border-color: red;
  }

  .button-row {
    display: flex;
    justify-content: space-between;
    margin-top: 20px;
  }

  .button-row button {
    background-color: #007bff;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    margin-bottom: 10px;
    width: 48%;
  }

  .button-row button:disabled {
    background-color: #b0c4de;
    cursor: not-allowed;
  }

  .button-row button:hover:enabled {
    background-color: #0056b3;
  }

  .modal {
    display: flex;
    justify-content: center;
    align-items: center;
    position: fixed;
    z-index: 1000;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
  }

  .modal-content {
    background-color: white;
    padding: 20px;
    border-radius: 8px;
    width: 90%;
    max-width: 400px;
    text-align: center;
    position: relative;
  }

  .close-button {
    position: absolute;
    top: 10px;
    right: 10px;
    font-size: 24px;
    cursor: pointer;
  }

  .error {
    color: red;
    text-align: center;
    margin-bottom: 15px;
  }

  .clipboard-message {
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: #28a745;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    z-index: 1000; /* Ensure it appears above other content */
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
</style>
