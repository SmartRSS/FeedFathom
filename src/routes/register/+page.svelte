<script lang="ts">
  import { goto } from "$app/navigation";
  import * as v from "valibot";

  const RegisterResponse = v.strictObject({
    success: v.boolean(),
    error: v.optional(v.nullable(v.string())),
  });

  let username = "";
  let email = "";
  let password = "";
  let passwordConfirm = "";
  let validationMessage = "";
  let isSubmitting = false;

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();

    console.log("Submitting registration form");

    if (password !== passwordConfirm) {
      validationMessage = "Passwords do not match!";
      return;
    }

    try {
      isSubmitting = true;
      const res = await fetch("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password, passwordConfirm }),
      });

      console.log("Response status:", res.status);
      const result = v.safeParse(RegisterResponse, await res.json());
      console.log("Response data:", result);

      if (!result.success) {
        validationMessage = "Unexpected server response";
        return;
      }

      if (res.ok) {
        await goto("/login");
      } else {
        validationMessage =
          result.issues || "Registration failed. Please try again.";
      }
    } catch (error) {
      validationMessage = "An error occurred. Please try again later.";
    } finally {
      isSubmitting = false;
    }
  };

  $: {
    if (password && passwordConfirm && password !== passwordConfirm) {
      validationMessage = "Passwords do not match!";
    } else if (!validationMessage.includes("Registration")) {
      // Only clear validation if it's not a server error
      validationMessage = "";
    }
  }
</script>

<main>
  <div class="form-container">
    <form on:submit={handleSubmit} class="register-form">
      <fieldset>
        <legend>Register</legend>
        <div class="input-block">
          <label for="username">Username:</label>
          <input id="username" type="text" bind:value={username} required />
        </div>

        <div class="input-block">
          <label for="email">Email:</label>
          <input id="email" type="email" bind:value={email} required />
        </div>

        <div class="input-block">
          <label for="password">Password:</label>
          <input id="password" type="password" bind:value={password} required />
        </div>

        <div class="input-block">
          <label for="passwordConfirm">Confirm Password:</label>
          <input
            id="passwordConfirm"
            type="password"
            bind:value={passwordConfirm}
            required
          />
        </div>

        <div class="validation-message" class:show={validationMessage}>
          {validationMessage}
        </div>

        <div class="button-block">
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Registering..." : "Register"}
          </button>
        </div>

        <a href="/login" class="login-link">Login</a>
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

  .validation-message {
    color: #d32f2f;
    margin-bottom: 15px;
    text-align: center;
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .validation-message.show {
    opacity: 1;
  }

  button:disabled {
    background-color: #cccccc;
    cursor: not-allowed;
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

  .login-link {
    display: block;
    margin-top: 20px;
    text-align: center;
    text-decoration: none;
    color: #007bff;
  }

  .login-link:hover {
    text-decoration: underline;
  }
</style>
