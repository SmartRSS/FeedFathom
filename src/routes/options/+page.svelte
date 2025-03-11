<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: bound by Svelte
import { enhance } from "$app/forms";
import type { SubmitFunction } from "@sveltejs/kit";
import { isMimeText } from "../../util/is-mime-text.ts";
import { isPlainText } from "../../util/is-plain-text.ts";
import { logError } from "../../util/log.ts";

// Access props directly
const { data } = $props();
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const { user } = data;

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
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

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
const changePassword: SubmitFunction = ({ formData, cancel }) => {
  for (const field of ["oldPassword", "password1", "password2"]) {
    if (!formData.get(field)) {
      logError(`no ${field}`);
      cancel();
      return;
    }
  }
};

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let valid = $state(true);

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
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
</script>

<div class="form-container">
  <a class="close-button" href="/">X</a>
  {#if user.isAdmin}
    <a href="/admin">Admin Panel</a> <!-- Link to the admin panel -->
  {/if}
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
</style>
