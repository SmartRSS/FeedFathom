import {
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  loginResponse,
  registrationResponse,
  successResponse,
  type Registration,
} from "#shared/contracts/responses.ts";
import type { Turnstile } from "./turnstile.d.ts";
import { api } from "./api.ts";
import { loginPath, registerPath } from "./behavior.ts";

export function Login(props: { navigate(to: string): void; next: string }) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [resetEnabled, setResetEnabled] = createSignal(false);
  // With no outgoing mail configured there is no link to deliver, so the
  // route answers as it would for an unknown account and offering it here
  // would only send people somewhere that cannot help them. A failure to
  // load leaves the link hidden, which is the same harmless outcome.
  onMount(async () => {
    try {
      setResetEnabled(
        (await api("/register", registrationResponse)).passwordResetEnabled,
      );
    } catch {
      setResetEnabled(false);
    }
  });
  async function submit(event: Event) {
    event.preventDefault();
    try {
      await api("/login", loginResponse, {
        body: JSON.stringify({ email: email(), password: password() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      props.navigate(props.next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed");
    }
  }
  return (
    <main>
      <form onSubmit={submit}>
        <h1>FeedFathom</h1>
        <label>
          Email
          <input
            type="email"
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </label>
        <Show when={error()}>
          {(message) => <p role="alert">{message()}</p>}
        </Show>
        <button>Login</button>
        <Show when={resetEnabled()}>
          <a
            href="/password-reset"
            onClick={(event) => {
              event.preventDefault();
              props.navigate("/password-reset");
            }}
          >
            Forgot your password?
          </a>
        </Show>
        <a
          href={registerPath(props.next)}
          onClick={(event) => {
            event.preventDefault();
            props.navigate(registerPath(props.next));
          }}
        >
          Register instead
        </a>
      </form>
    </main>
  );
}

export function Register(props: { navigate(to: string): void; next: string }) {
  let turnstileContainer!: HTMLDivElement;
  let turnstileScript: HTMLScriptElement | undefined;
  let turnstileLoaded: (() => void) | undefined;
  let turnstileRendered = false;
  let disposed = false;
  const [registration, setRegistration] = createSignal<Registration | null>();
  const [username, setUsername] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [turnstileToken, setTurnstileToken] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [registered, setRegistered] = createSignal(false);

  function renderTurnstile(sitekey: string) {
    const turnstile: Turnstile | undefined = window.turnstile;
    if (disposed || turnstileRendered || !turnstile) return;
    turnstile.render(turnstileContainer, {
      callback: setTurnstileToken,
      "error-callback": () => {
        setTurnstileToken("");
        setMessage("CAPTCHA verification failed. Please try again.");
      },
      "expired-callback": () => setTurnstileToken(""),
      sitekey,
    });
    turnstileRendered = true;
  }

  function loadTurnstile(sitekey: string) {
    if (disposed) return;
    turnstileLoaded = () => renderTurnstile(sitekey);
    turnstileScript =
      document.querySelector<HTMLScriptElement>(
        "#cloudflare-turnstile-script",
      ) ?? undefined;
    const newScript = !turnstileScript;
    if (!turnstileScript) {
      turnstileScript = document.createElement("script");
      turnstileScript.id = "cloudflare-turnstile-script";
      turnstileScript.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      turnstileScript.async = true;
      turnstileScript.defer = true;
    }
    turnstileScript.addEventListener("load", turnstileLoaded);
    if (newScript) document.head.append(turnstileScript);
    turnstileLoaded();
  }

  onMount(async () => {
    try {
      const info = await api("/register", registrationResponse);
      if (disposed) return;
      setRegistration(info);
      if (info.registrationStatus !== "DISABLED" && info.turnstileSiteKey)
        queueMicrotask(() => loadTurnstile(info.turnstileSiteKey!));
    } catch (cause) {
      if (disposed) return;
      setRegistration(null);
      setMessage(
        cause instanceof Error ? cause.message : "Could not load registration.",
      );
    }
  });
  onCleanup(() => {
    disposed = true;
    if (turnstileLoaded)
      turnstileScript?.removeEventListener("load", turnstileLoaded);
  });

  async function submit(event: Event) {
    event.preventDefault();
    if (password() !== confirm()) {
      setMessage("Passwords do not match.");
      return;
    }
    const sitekey = registration()?.turnstileSiteKey;
    if (sitekey && !turnstileToken()) {
      setMessage("Please complete the CAPTCHA before submitting.");
      return;
    }
    try {
      setMessage("");
      await api("/register", successResponse, {
        body: JSON.stringify({
          email: email(),
          password: password(),
          passwordConfirm: confirm(),
          username: username(),
          ...(sitekey ? { "cf-turnstile-response": turnstileToken() } : {}),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setRegistered(true);
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Registration failed",
      );
    }
  }
  return (
    <main>
      <Switch>
        <Match when={registration() === undefined}>
          <p role="status">Loading registration…</p>
        </Match>
        <Match when={registration() === null}>
          <h1>Register</h1>
          <p role="alert">{message()}</p>
          <LoginLink navigate={props.navigate} next={props.next} />
        </Match>
        <Match when={registration()?.registrationStatus === "DISABLED"}>
          <h1>Registration unavailable</h1>
          <p>New user registrations are currently not being accepted.</p>
          <LoginLink navigate={props.navigate} next={props.next} />
        </Match>
        <Match when={registered()}>
          <section class="account-result">
            <h1>Registration successful</h1>
            <p>
              Your account has been created. If activation is required, check
              your email before logging in.
            </p>
            <LoginLink navigate={props.navigate} next={props.next} />
          </section>
        </Match>
        <Match when={registration()}>
          {(info) => (
            <form onSubmit={submit}>
              <h1>
                {info().registrationStatus === "FIRST_USER"
                  ? "Create administrator account"
                  : "Register"}
              </h1>
              <label>
                Name
                <input
                  autocomplete="nickname"
                  value={username()}
                  onInput={(event) => setUsername(event.currentTarget.value)}
                  required
                />
              </label>
              <label>
                Email
                <input
                  autocomplete="email"
                  type="email"
                  value={email()}
                  onInput={(event) => setEmail(event.currentTarget.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  autocomplete="new-password"
                  type="password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  required
                />
              </label>
              <label>
                Confirm password
                <input
                  autocomplete="new-password"
                  type="password"
                  value={confirm()}
                  onInput={(event) => setConfirm(event.currentTarget.value)}
                  required
                />
              </label>
              <Show when={info().turnstileSiteKey}>
                <div ref={turnstileContainer} />
              </Show>
              <Show when={message()}>
                {(text) => <p role="alert">{text()}</p>}
              </Show>
              <button>Register</button>
              <LoginLink navigate={props.navigate} next={props.next} />
            </form>
          )}
        </Match>
      </Switch>
    </main>
  );
}

function LoginLink(props: { navigate(to: string): void; next?: string }) {
  const path = () =>
    props.next === undefined ? "/login" : loginPath(props.next);
  return (
    <a
      href={path()}
      onClick={(event) => {
        event.preventDefault();
        props.navigate(path());
      }}
    >
      Login
    </a>
  );
}

export function Activate(props: { token: string; navigate(to: string): void }) {
  const [result, setResult] = createSignal<"loading" | "success" | "error">(
    "loading",
  );
  const [message, setMessage] = createSignal("");

  onMount(async () => {
    try {
      await api(
        `/activate/${encodeURIComponent(props.token)}`,
        successResponse,
        {
          method: "POST",
        },
      );
      setResult("success");
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Account activation failed.",
      );
      setResult("error");
    }
  });

  return (
    <main>
      <section class="account-result">
        <h1>Account activation</h1>
        <Switch>
          <Match when={result() === "loading"}>
            <p role="status">Activating your account…</p>
          </Match>
          <Match when={result() === "success"}>
            <p role="status">Your account has been activated.</p>
          </Match>
          <Match when={result() === "error"}>
            <p role="alert">{message()}</p>
          </Match>
        </Switch>
        <LoginLink navigate={props.navigate} />
      </section>
    </main>
  );
}

export function PasswordReset(props: { navigate(to: string): void }) {
  const [email, setEmail] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const [message, setMessage] = createSignal("");

  async function submit(event: Event) {
    event.preventDefault();
    try {
      await api("/password-reset", successResponse, {
        body: JSON.stringify({ email: email() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setSent(true);
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Could not send the email.",
      );
    }
  }

  return (
    <main>
      <Show
        when={!sent()}
        fallback={
          <section class="account-result">
            <h1>Reset your password</h1>
            {/* Deliberately not "we sent you an email": saying so only when
                the account exists would answer the question the login form
                refuses to. */}
            <p role="status">
              If that address has an account here, a reset link is on its way.
              The link is good for one hour.
            </p>
            <LoginLink navigate={props.navigate} />
          </section>
        }
      >
        <form onSubmit={submit}>
          <h1>Reset your password</h1>
          <label>
            Email
            <input
              autocomplete="email"
              type="email"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
              required
            />
          </label>
          <Show when={message()}>{(text) => <p role="alert">{text()}</p>}</Show>
          <button>Send reset link</button>
          <LoginLink navigate={props.navigate} />
        </form>
      </Show>
    </main>
  );
}

export function PasswordResetConfirm(props: {
  navigate(to: string): void;
  token: string;
}) {
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [done, setDone] = createSignal(false);
  const [message, setMessage] = createSignal("");

  async function submit(event: Event) {
    event.preventDefault();
    if (password() !== confirm()) {
      setMessage("The two passwords do not match.");
      return;
    }
    try {
      await api("/password-reset/confirm", successResponse, {
        body: JSON.stringify({
          password1: password(),
          password2: confirm(),
          token: props.token,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setDone(true);
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Could not reset the password.",
      );
    }
  }

  return (
    <main>
      <Show
        when={!done()}
        fallback={
          <section class="account-result">
            <h1>Reset your password</h1>
            <p role="status">
              Your password has been changed, and every other session has been
              signed out.
            </p>
            <LoginLink navigate={props.navigate} />
          </section>
        }
      >
        <form onSubmit={submit}>
          <h1>Choose a new password</h1>
          <label>
            New password
            <input
              autocomplete="new-password"
              type="password"
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            Confirm password
            <input
              autocomplete="new-password"
              type="password"
              value={confirm()}
              onInput={(event) => setConfirm(event.currentTarget.value)}
              required
            />
          </label>
          <Show when={message()}>{(text) => <p role="alert">{text()}</p>}</Show>
          <button>Set new password</button>
          <LoginLink navigate={props.navigate} />
        </form>
      </Show>
    </main>
  );
}
