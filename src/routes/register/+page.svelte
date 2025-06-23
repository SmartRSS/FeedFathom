<script lang="ts">
  import { logError } from "../../util/log.ts";

  const { data } = $props();

  let form: HTMLFormElement | undefined = $state(undefined);
  let response: { success: boolean; error?: string } | null = $state(null);
  let loading = $state(false);
  let password = $state("");
  let passwordConfirm = $state("");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!form) {
      return;
    }

    loading = true;

    const formData = new FormData(form);
    const body = {
      username: formData.get("username"),
      email: formData.get("email"),
      password: formData.get("password"),
      passwordConfirm: formData.get("password-confirm"),
      "cf-turnstile-response": formData.get("cf-turnstile-response"),
    };

    try {
      const res = await fetch("/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        if (res.status === 409) {
          response = {
            success: false,
            error: "An account with this email already exists",
          };
          return;
        }

        response = {
          success: false,
          error: "An unexpected error occurred. Please try again.",
        };

        return;
      }

      response = (await res.json()) as { success: boolean; error?: string };
    } catch (error) {
      logError("Registration form submission failed:", error);
      response = {
        success: false,
        error: "Failed to connect to the server. Please try again later.",
      };
    } finally {
      loading = false;
    }
  };
</script>

<svelte:head>
  <title>Register</title>
  {#if data.turnstileSiteKey}
    <script
      src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
      async
      defer
    ></script>
  {/if}
</svelte:head>

<div class="container">
  {#if response?.success}
    <div class="registration-success">
      <h2>Registration Successful!</h2>
      <p>
        Your account has been created. You can now
        <a href="/login">log in</a>.
      </p>
    </div>
  {:else}
    {#if data.registrationStatus === "DISABLED"}
      <div class="registration-disabled">
        <h2>Registration Closed</h2>
        <p>
          New user registrations are currently not being accepted. Please
          contact the administrator if you believe this is an error.
        </p>
      </div>
    {:else}
      {#if data.registrationStatus === "FIRST_USER"}
        <h2>Create Administrator Account</h2>
        <p class="sub-header">
          Welcome! As the first user, your account will have administrative
          privileges. After you register, new user registrations will be
          disabled by default.
        </p>
      {:else}
        <h2>Create an Account</h2>
      {/if}

      <form
        class="registration-form"
        onsubmit={submit}
        bind:this={form}
      >
        <div class="form-group">
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            required
            autocomplete="nickname"
          />
        </div>

        <div class="form-group">
          <label for="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autocomplete="email"
          />
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            bind:value={password}
            autocomplete="new-password"
          />
        </div>

        <div class="form-group">
          <label for="password-confirm">Confirm Password</label>
          <input
            id="password-confirm"
            name="password-confirm"
            type="password"
            required
            bind:value={passwordConfirm}
            autocomplete="new-password"
          />
        </div>
        {#if password !== passwordConfirm}
          <p class="error-message">Passwords do not match.</p>
        {/if}

        {#if response && !response.success}
          <p class="error-message">{response.error}</p>
        {/if}
        {#if data.turnstileSiteKey}
          <div
            class="cf-turnstile"
            data-sitekey={data.turnstileSiteKey}
            data-theme="light"
          >
          </div>
        {/if}
        <button
          type="submit"
          class="btn-submit"
          disabled={loading || password !== passwordConfirm || !password}
        >
          {#if loading}
            <span>Creating Account...</span>
          {:else}
            <span>Create Account</span>
          {/if}
        </button>
      </form>
      <div class="login-link">
        <p>Already have an account? <a href="/login">Log in</a></p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background-color: #f7f7f7;
    padding: 2rem;
  }

  h2 {
    margin-bottom: 0.5rem;
    color: #333;
  }

  .sub-header {
    margin-bottom: 2rem;
    color: #555;
    text-align: center;
    max-width: 400px;
  }

  .registration-form,
  .registration-success,
  .registration-disabled {
    background: #fff;
    padding: 2rem;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    width: 100%;
    max-width: 400px;
  }

  .registration-disabled {
    text-align: center;
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: #444;
  }

  input[type="text"],
  input[type="email"],
  input[type="password"] {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-sizing: border-box;
    transition:
      border-color 0.2s,
      box-shadow 0.2s;
  }

  input[type="text"]:focus,
  input[type="email"]:focus,
  input[type="password"]:focus {
    outline: none;
    border-color: #007bff;
    box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
  }

  .btn-submit {
    width: 100%;
    padding: 0.75rem;
    border: none;
    border-radius: 4px;
    background-color: #007bff;
    color: white;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .btn-submit:disabled {
    background-color: #a0cfff;
    cursor: not-allowed;
  }

  .btn-submit:not(:disabled):hover {
    background-color: #0056b3;
  }

  .error-message {
    color: #d93025;
    margin-top: -1rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .login-link {
    margin-top: 1.5rem;
    text-align: center;
  }

  .login-link a {
    color: #007bff;
    text-decoration: none;
  }

  .login-link a:hover {
    text-decoration: underline;
  }
</style>
