<script lang="ts">
  import { goto } from "$app/navigation";

  let email = "";
  let password = "";

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      return await goto("/");
    }
    alert("Wrong login info");
  };
</script>

<main>
  <div class="form-container">
    <form on:submit={handleSubmit} class="login-form">
      <fieldset>
        <legend>Login Information</legend>
        <div class="input-block">
          <label for="email">Email:</label>
          <input id="email" type="email" bind:value={email} required />
        </div>

        <div class="input-block">
          <label for="password">Password:</label>
          <input id="password" type="password" bind:value={password} required />
        </div>

        <!-- Submit block for login -->
        <div class="button-block">
          <button type="submit">Login</button>
        </div>

        <a href="/register" class="register-link">Register instead</a>
      </fieldset>
    </form>
  </div>
</main>

<style>
  main {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    padding: 20px; /* Add some padding to the main container */
  }

  .form-container {
    width: 100%;
    max-width: 768px; /* Increase the max-width to make the form wider */
    margin: auto;
    padding: 20px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background-color: white;
  }

  fieldset {
    border: none;
    padding: 0;
  }

  legend {
    font-size: 1.5em;
    margin-bottom: 10px;
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
    font-size: 1em;
  }

  .button-block {
    text-align: center;
    margin-top: 20px;
  }

  .button-block button {
    background-color: #007bff;
    color: white;
    padding: 10px 20px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    width: 48%; /* Ensure buttons stay in line by assigning width */
  }

  .button-block button:hover {
    background-color: #0056b3;
  }

  .register-link {
    display: block;
    margin-top: 20px;
    text-align: center;
    text-decoration: none;
    color: #007bff;
  }

  .register-link:hover {
    text-decoration: underline;
  }
</style>
