<script lang="ts">
  interface Source {
    url: string;
    created_at: string; // or Date if you prefer
    last_attempt: string; // or Date
    last_success: string; // or Date
    subscriber_count: number;
    recent_failure_details: string;
    recent_failures: number;
  }

  const { data } = $props();
  let sources: Source[] = $state(data.sources) as Source[]; // Define the type of sources
  let order = "asc";

  const fetchSortedSources = async (field: string) => {
    const response = await fetch(`/admin?sortBy=${field}&order=${order}`);
    if (response.ok) {
      sources = (await response.json()) as Source[]; // Update sources with the new data
    } else {
      console.error("Failed to fetch sorted sources");
    }
  };

  const sortSources = (field: string) => {
    order = order === "asc" ? "desc" : "asc"; // Toggle order
    fetchSortedSources(field);
  };
</script>

<div class="table-container">
  <h1>Admin Panel</h1>
  <h2>Sources</h2>
  <table>
    <thead>
      <tr>
        <th onclick={() => sortSources("url")}>URL</th>
        <th onclick={() => sortSources("created_at")}>Created At</th>
        <th onclick={() => sortSources("last_attempt")}>Last Attempt</th>
        <th onclick={() => sortSources("last_success")}>Last Success</th>
        <th onclick={() => sortSources("subscriber_count")}>Subscriber Count</th
        >
        <th onclick={() => sortSources("recent_failures")}>Failures</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      {#each sources as source}
        <tr>
          <td>{source["url"]}</td>
          <td>{new Date(source["created_at"]).toISOString()}</td>
          <td>{new Date(source["last_attempt"]).toISOString()}</td>
          <td>{new Date(source["last_success"]).toISOString()}</td>
          <td>{source["subscriber_count"]}</td>
          <td>{source["recent_failures"]}</td>
          <td>{source["recent_failure_details"]}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

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
</style>
