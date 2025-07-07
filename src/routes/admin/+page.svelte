<script lang="ts">
    import type { SourceWithSubscriberCount } from '../../db/data-services/source-data-service.ts';



const { data } = $props();

let sources = $state(data.sources); // Define the type of sources
let order = "asc";

let currentSourceUrl = ""; // Store the current source URL

let newSourceUrl = $state(""); // Store the new source URL

let redirects = $state<Record<string, string>>({});
let showRedirects = $state(false);

const fetchRedirects = async () => {
  const response = await fetch("/admin/redirects");
  if (response.ok) {
    redirects = (await response.json()) as Record<string, string>;
  }
};

const removeRedirect = async (oldUrl: string) => {
  const response = await fetch("/admin/redirects", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ oldUrl }),
  });

  if (response.ok) {
    await fetchRedirects();
  }
};

const fetchSortedSources = async (field: string) => {
  const response = await fetch(`/admin?sortBy=${field}&order=${order}`);
  if (response.ok) {
    sources = (await response.json()) as SourceWithSubscriberCount[]; // Update sources with the new data
  } else {
  }
};


const sortSources = (field: string) => {
  order = order === "asc" ? "desc" : "asc"; // Toggle order
  fetchSortedSources(field);
};


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


const openModal = (sourceUrl: string) => {
  currentSourceUrl = sourceUrl; // Set the current source URL
  newSourceUrl = sourceUrl; // Pre-fill the new URL input
  const dialog = document.getElementById("edit-dialog") as HTMLDialogElement;
  dialog.showModal(); // Show the dialog
};


const closeModal = () => {
  const dialog = document.getElementById("edit-dialog") as HTMLDialogElement;
  dialog.close(); // Close the dialog
};
</script>

<div class="table-container">
  <h1>Admin Panel</h1>
  
  <div class="admin-sections">
    <button 
      class="section-toggle" 
      onclick={() => { showRedirects = !showRedirects; if (showRedirects) fetchRedirects(); }}
    >
      {showRedirects ? 'Hide' : 'Show'} Redirect Management
    </button>
    
    {#if showRedirects}
      <div class="redirect-section">
        <h2>Redirect Mappings</h2>
        <table>
          <thead>
            <tr>
              <th>Old URL</th>
              <th>New URL</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(redirects) as [oldUrl, newUrl] (oldUrl)}
              <tr>
                <td>{oldUrl}</td>
                <td>{newUrl}</td>
                <td>
                  <button onclick={() => removeRedirect(oldUrl)}>Remove</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    
        <h2>Sources</h2>
  </div>
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
      {#each sources as source (source.url)}
        <tr>
          <td>
            <button onclick={() => openModal(source.url)}>Edit</button>
          </td>
          <td>
            {source.url}
          </td>
          <td>{new Date(source.createdAt).toISOString()}</td>
          <td>{source.lastAttempt ? new Date(source.lastAttempt).toISOString() : "N/A"}</td>
          <td>{source.lastSuccess ? new Date(source.lastSuccess).toISOString() : "N/A"}</td>
          <td>{source.subscriberCount}</td>
          <td>{source.recentFailures}</td>
          <td>{source.recentFailureDetails}</td>
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

  .admin-sections {
    margin-bottom: 30px;
  }

  .section-toggle {
    background-color: #007bff;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 5px;
    cursor: pointer;
    margin-bottom: 20px;
  }

  .section-toggle:hover {
    background-color: #0056b3;
  }

  .redirect-section {
    margin-bottom: 30px;
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
