<script lang="ts">

import { enhance } from "$app/forms";
import type { SubmitFunction } from "@sveltejs/kit";
import { isMimeText } from "../../util/is-mime-text.ts";
import { isPlainText } from "../../util/is-plain-text.ts";
import { logError } from "../../util/log.ts";
import { browser } from "$app/environment";

// Access props directly
const { data } = $props();

const { user } = data;


const uploadOpml: SubmitFunction = async ({ formData, cancel }) => {
  const file = (formData as FormData).get("opml") as File;
  if (!file) {
    cancel();
    alert("No file selected");
    return;
  }
  if (!isMimeText(file.type)) {
    cancel();
    alert("Invalid file type");
    return;
  }
  if (!(file.name.endsWith(".opml") || file.name.endsWith(".xml"))) {
    cancel();
    alert("Invalid file extension");
    return;
  }
  if (file.size > 100_000) {
    cancel();
    alert("File too large");
    return;
  }
  const fileContents = await file.text();
  if (!isPlainText(fileContents)) {
    cancel();
    alert("Invalid file contents 1");
    return;
  }
};
let passwordForm: HTMLFormElement;


const changePassword: SubmitFunction = ({ formData, cancel }) => {
  for (const field of ["oldPassword", "password1", "password2"]) {
    if (!formData.get(field)) {
      logError(`no ${field}`);
      cancel();
      return;
    }
  }
};


let valid = $state(true);


function isValid() {
  if (!passwordForm["password1"].value) {
    valid = true;
    return;
  }
  if (!passwordForm["password2"].value) {
    valid = true;
    return;
  }
  valid = passwordForm["password1"].value === passwordForm["password2"].value;
}

// Detect browser type
function getBrowserType(): "firefox" | "chrome" | "other" {
  if (browser) {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes("firefox")) {
      return "firefox";
    } else if (userAgent.includes("chrome")) {
      return "chrome";
    }
  }
  return "other";
}

// Get download URL based on browser
function getDownloadUrl(): string {
  const browserType = getBrowserType();
  const baseUrl = "https://smartrss.github.io/FeedFathom";

  if (browserType === "firefox") {
    return `${baseUrl}/assets/extension/FeedFathom_ff.xpi`;
  } else if (browserType === "chrome") {
    return `${baseUrl}/assets/extension/FeedFathom_ch.zip`;
  }
  return baseUrl; // Fallback to base URL for other browsers
}

// Get browser name for display
function getBrowserName(): string {
  return "your browser";
}
</script>

<div class="form-container">
  <a class="close-button" href="/">X</a>
  {#if user.isAdmin}
    <a href="/admin">Admin Panel</a> <!-- Link to the admin panel -->
  {/if}

  <div class="download-section">
    <h3>Download Extension</h3>
    <p>Get the FeedFathom extension for {getBrowserName()}:</p>
    <a href={getDownloadUrl()} class="download-button" target="_blank" rel="noopener noreferrer">
      Download Extension
    </a>
  </div>

  <form
    action="?/importOpml"
    class="import-form"
    enctype="multipart/form-data"
    method="post"
    use:enhance={uploadOpml}
  >
    <div class="input-block">
      <label for="opml">Import OPML:</label>
      <input accept=".opml,.xml" id="opml" name="opml" required type="file" />
    </div>
    <div class="submit-block">
      <button type="submit">Submit</button>
    </div>
  </form>
  <form
    action="?/changePassword"
    bind:this={passwordForm}
    class="import-form"
    method="post"
    use:enhance={changePassword}
  >
    <div class="input-block">
      <label for="oldPassword">Old password:</label>
      <input id="oldPassword" name="oldPassword" required type="password" />
    </div>
    <div class="input-block" class:error={!valid}>
      <label for="password1">New password:</label>
      <input
        id="password1"
        name="password1"
        onchange={isValid}
        required
        type="password"
      />
    </div>
    <div class="input-block" class:error={!valid}>
      <label for="password2">Repeat:</label>
      <input
        id="password2"
        name="password2"
        onchange={isValid}
        required
        type="password"
      />
    </div>
    <div class="submit-block">
      <button type="submit">Submit</button>
    </div>
  </form>
</div>

<style>
  .input-block {
    box-sizing: border-box;
    border: rgba(0, 0, 0, 0) 1px solid;
    border-radius: 4px;
    padding: 0.4rem;
  }

  .input-block.error {
    border: red 1px solid;
  }

  .form-container {
    display: flex;
    min-height: 100vh;
    flex-direction: column;
  }

  .close-button {
    position: absolute;
    top: 20px;
    right: 20px;
    background: none;
    border: none;
    font-size: 24px;
    text-decoration: none; /* Remove default anchor underline */
    color: black; /* Set color to black or any color of your choice */
    cursor: pointer;
  }

  .import-form {
    display: flex;
    flex-direction: column;
    max-width: 300px;
    padding: 20px;
    border: 1px solid #ddd;
    border-radius: 8px;
    margin: 10px 0;
  }

  .import-form:first-child {
    margin-top: auto;
  }

  .import-form:last-child {
    margin-bottom: auto;
  }

  .input-block {
    margin-bottom: 15px;
  }

  .input-block label {
    font-weight: bold;
    margin-bottom: 5px;
    display: inline-block;
  }

  .input-block input {
    padding: 10px;
    width: 100%;
    border: 1px solid #ccc;
    border-radius: 4px;
  }

  .submit-block {
    text-align: center;
  }

  .submit-block button {
    background-color: #007bff;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
  }

  .submit-block button:hover {
    background-color: #0056b3;
  }

  .download-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 300px;
    padding: 20px;
    border: 1px solid #ddd;
    border-radius: 8px;
    margin: 10px 0;
    text-align: center;
  }

  .download-section h3 {
    margin: 0 0 10px 0;
    color: #333;
  }

  .download-section p {
    margin: 0 0 15px 0;
    color: #666;
  }

  .download-button {
    background-color: #007bff;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    text-decoration: none;
    transition: background-color 0.2s;
  }

  .download-button:hover {
    background-color: #0056b3;
  }
</style>
