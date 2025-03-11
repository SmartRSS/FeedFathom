<script lang="ts">
interface Source {
  url: string;
  // biome-ignore lint/style/useNamingConvention: <explanation>
  created_at: string; // or Date if you prefer
  // biome-ignore lint/style/useNamingConvention: <explanation>
  last_attempt: string; // or Date
  // biome-ignore lint/style/useNamingConvention: <explanation>
  last_success: string; // or Date
  // biome-ignore lint/style/useNamingConvention: <explanation>
  subscriber_count: number;
  // biome-ignore lint/style/useNamingConvention: <explanation>
  recent_failure_details: string;
  failures: number;
}

const { data } = $props();
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let sources: Source[] = $state(data.sources) as Source[]; // Define the type of sources
let order = "asc";
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let currentSourceUrl = ""; // Store the current source URL
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let newSourceUrl = $state(""); // Store the new source URL

const fetchSortedSources = async (field: string) => {
  const response = await fetch(`/admin?sortBy=${field}&order=${order}`);
  if (response.ok) {
    sources = (await response.json()) as Source[]; // Update sources with the new data
  } else {
  }
};

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const sortSources = (field: string) => {
  order = order === "asc" ? "desc" : "asc"; // Toggle order
  fetchSortedSources(field);
};

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const updateSource = async (oldUrl: string, newUrl: string) => {
  const response = await fetch("/admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ oldUrl, newUrl }), // Send both old and new URLs
  });

  if (response.ok) {
    fetchSortedSources("created_at"); // Refresh the sources
  } else {
  }
};

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const openModal = (sourceUrl: string) => {
  currentSourceUrl = sourceUrl; // Set the current source URL
  newSourceUrl = sourceUrl; // Pre-fill the new URL input
  const dialog = document.getElementById("edit-dialog") as HTMLDialogElement;
  dialog.showModal(); // Show the dialog
};

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const closeModal = () => {
  const dialog = document.getElementById("edit-dialog") as HTMLDialogElement;
  dialog.close(); // Close the dialog
};
</script>

<div class="table-container">
  <h1>Admin Panel</h1>
  <h2>Sources</h2>
  <table>
    <thead>
      <tr>
        <th>Action</th>
        <th onclick={() => sortSources("url")}>URL</th>
        <th onclick={() => sortSources("created_at")}>Created At</th>
        <th onclick={() => sortSources("last_attempt")}>Last Attempt</th>
        <th onclick={() => sortSources("last_success")}>Last Success</th>
        <th onclick={() => sortSources("subscriber_count")}>Subscriber Count</th
        >
        <th onclick={() => sortSources("failures")}>Failures</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      {#each sources as source}
        <tr>
          <td>
            <button onclick={() => openModal(source.url)}>Edit</button>
          </td>
          <td>
            {source.url}
          </td>
          <td>{new Date(source["created_at"]).toISOString()}</td>
          <td>{new Date(source["last_attempt"]).toISOString()}</td>
          <td>{new Date(source["last_success"]).toISOString()}</td>
          <td>{source["subscriber_count"]}</td>
          <td>{source["failures"]}</td>
          <td>{source["recent_failure_details"]}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<dialog id="edit-dialog">
  <div class="modal-content">
    <button class="close" onclick={closeModal} aria-label="Close modal"
      >&times;</button
    >
    <h2>Edit Source URL</h2>
    <label for="new-url">New URL:</label>
    <input type="text" id="new-url" bind:value={newSourceUrl} />
    <button onclick={() => updateSource(currentSourceUrl, newSourceUrl)}
      >Update</button
    >
    <button onclick={closeModal}>Cancel</button>
  </div>
</dialog>

<style>
  h1 {
    text-align: center;
    margin-bottom: 20px;
  }

  h2 {
    text-align: center;
    margin-bottom: 10px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 auto; /* Center the table */
    max-width: 800px; /* Limit the width */
  }

  th,
  td {
    padding: 12px 15px; /* Add padding */
    text-align: left;
    border: 1px solid #ddd; /* Add border */
  }

  th {
    background-color: #007bff; /* Header background color */
    color: white; /* Header text color */
    font-weight: bold; /* Bold text */
  }

  tr:hover {
    background-color: #f1f1f1; /* Row hover effect */
  }

  tr:nth-child(even) {
    background-color: #f9f9f9; /* Zebra striping */
  }

  tr:nth-child(odd) {
    background-color: #ffffff; /* Zebra striping */
  }

  .table-container {
    padding: 20px; /* Add padding around the table */
    min-height: 100%;
    height: 100%;
    max-height: 100%;
    overflow: auto;
  }

  dialog {
    border: none;
    border-radius: 8px;
    padding: 20px;
    background-color: #fefefe;
    max-width: 500px;
    width: 80%;
  }

  .modal-content {
    display: flex;
    flex-direction: column;
  }

  .close {
    color: #aaa;
    float: right;
    font-size: 28px;
    font-weight: bold;
  }

  .close:hover,
  .close:focus {
    color: black;
    text-decoration: none;
    cursor: pointer;
  }
</style>
