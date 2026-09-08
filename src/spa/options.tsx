import { createSignal, onMount, Show } from "solid-js";
import type { Static } from "typebox";
import {
  sessionResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import { api } from "./api.ts";
import { loginPath } from "./behavior.ts";
import { PasswordInput } from "./password-input.tsx";
import {
  isMarkReadPolicy,
  isReaderStep,
  isTheme,
  markReadPolicy,
  readerText,
  readerWidth,
  rememberReadingPosition,
  setMarkReadPolicy,
  setReaderText,
  setReaderWidth,
  setRememberReadingPosition,
  setTheme,
  setTodayView,
  theme,
  todayView,
} from "./preferences.ts";
import { dateFormat, isDateFormat, setDateFormat } from "./format-date.ts";
import {
  isOnOff,
  setBackgroundPollEnabled,
  setUnreadBadgeEnabled,
  unreadBadgeEnabled,
  backgroundPollEnabled,
} from "./news-signal.ts";
import { prefetchNextEnabled, setPrefetchNext } from "./reading-prefetch.ts";
import { helpDialog } from "./dialog.tsx";

type SessionUser = NonNullable<Static<typeof sessionResponse>["user"]>;

export function Options(props: {
  handleUnauthorized(cause: unknown): boolean;
  navigate(to: string): void;
}) {
  const [oldPassword, setOldPassword] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [passwordConfirm, setPasswordConfirm] = createSignal("");
  const [passwordLoading, setPasswordLoading] = createSignal(false);
  const [passwordMessage, setPasswordMessage] = createSignal("");
  const [passwordFailed, setPasswordFailed] = createSignal(false);
  const [opmlLoading, setOpmlLoading] = createSignal(false);
  const [opmlMessage, setOpmlMessage] = createSignal("");
  const [opmlFailed, setOpmlFailed] = createSignal(false);
  const [user, setUser] = createSignal<SessionUser>();
  const [sessionMessage, setSessionMessage] = createSignal("");
  const [logoutLoading, setLogoutLoading] = createSignal(false);

  onMount(async () => {
    try {
      const session = await api("/session", sessionResponse);
      if (!session.user) {
        props.navigate(loginPath(location.pathname + location.search));
        return;
      }
      setUser(session.user);
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionMessage(
        cause instanceof Error ? cause.message : "Could not load session.",
      );
    }
    // The empty-tree guidance links here with a hash; the SPA navigation
    // never scrolls on its own, so honour the target once it is rendered.
    if (location.hash) {
      queueMicrotask(() => {
        document
          .querySelector(location.hash)
          ?.scrollIntoView({ block: "start" });
      });
    }
  });

  async function logout() {
    setLogoutLoading(true);
    setSessionMessage("");
    try {
      await api("/logout", successResponse, { method: "POST" });
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith("api-"))
            .map((key) => caches.delete(key)),
        );
      }
      if ("indexedDB" in window) {
        try {
          // Clearing the object store (rather than deleteDatabase) works
          // even while the service worker holds its own open connection to
          // this same database -- deleteDatabase requires every connection
          // closed first and would otherwise block indefinitely if the SW
          // is mid-flushQueue().
          await new Promise<void>((resolve, reject) => {
            const openRequest = window.indexedDB.open("mutation-queue", 1);
            openRequest.addEventListener("upgradeneeded", () => {
              openRequest.result.createObjectStore("mutations", {
                autoIncrement: true,
              });
            });
            openRequest.addEventListener("success", () => {
              const db = openRequest.result;
              const tx = db.transaction("mutations", "readwrite");
              tx.objectStore("mutations").clear();
              tx.addEventListener("complete", () => {
                db.close();
                resolve();
              });
              tx.addEventListener("error", () => {
                db.close();
                reject(tx.error);
              });
            });
            openRequest.addEventListener("error", () =>
              reject(openRequest.error),
            );
          });
        } catch {
          // Ignore: a queue clear failure must not block logout.
        }
      }
      props.navigate("/login");
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionMessage(
        cause instanceof Error ? cause.message : "Could not log out.",
      );
      setLogoutLoading(false);
    }
  }

  async function submitPassword(event: Event) {
    event.preventDefault();
    if (passwordLoading()) return;
    if (password() !== passwordConfirm()) {
      setPasswordFailed(true);
      setPasswordMessage("New passwords do not match.");
      return;
    }
    setPasswordLoading(true);
    setPasswordMessage("");
    try {
      await api("/options/password", successResponse, {
        body: JSON.stringify({
          oldPassword: oldPassword(),
          password1: password(),
          password2: passwordConfirm(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setPasswordFailed(false);
      setPasswordMessage("Password changed.");
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setPasswordFailed(true);
      setPasswordMessage(
        cause instanceof Error ? cause.message : "Could not change password.",
      );
    } finally {
      setPasswordLoading(false);
    }
  }

  async function submitOpml(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ) {
    event.preventDefault();
    if (opmlLoading()) return;
    setOpmlLoading(true);
    setOpmlMessage("");
    try {
      await api("/options/opml", successResponse, {
        body: new FormData(event.currentTarget),
        method: "POST",
      });
      setOpmlFailed(false);
      setOpmlMessage("Subscriptions imported.");
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setOpmlFailed(true);
      setOpmlMessage(
        cause instanceof Error ? cause.message : "Could not import OPML.",
      );
    } finally {
      setOpmlLoading(false);
    }
  }

  return (
    <main class="options-page">
      <h1>Options</h1>
      <a
        href="/"
        onClick={(event) => {
          event.preventDefault();
          props.navigate("/");
        }}
      >
        Home
      </a>
      <section class="options-card">
        <h2>Appearance</h2>
        <label>
          Theme
          <select
            value={theme()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isTheme(value)) setTheme(value);
            }}
          >
            <option value="auto">Auto (match OS colors)</option>
            <option value="smart">Smart</option>
            <option value="classic">Classic</option>
            <option value="millennial">Millennial</option>
            <option value="aero">Aero</option>
            <option value="modern">Modern</option>
            <option value="high-contrast">High contrast (accessibility)</option>
          </select>
        </label>
        <label>
          Date format
          <select
            value={dateFormat()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isDateFormat(value)) setDateFormat(value);
            }}
          >
            <option value="locale">System locale</option>
            <option value="iso">ISO 8601 (UTC)</option>
          </select>
        </label>
      </section>
      <section class="options-card">
        <h2>Reader</h2>
        <label>
          Text size
          <select
            value={readerText()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isReaderStep(value)) setReaderText(value);
            }}
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label>
          Line width
          <select
            value={readerWidth()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isReaderStep(value)) setReaderWidth(value);
            }}
          >
            <option value="small">Narrow</option>
            <option value="medium">Medium</option>
            <option value="large">Wide</option>
          </select>
        </label>
      </section>
      <section class="options-card">
        <h2>New-article signal</h2>
        <label>
          Unread count in tab title
          <select
            value={unreadBadgeEnabled()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isOnOff(value)) setUnreadBadgeEnabled(value);
            }}
          >
            <option value="on">Show</option>
            <option value="off">Hide</option>
          </select>
        </label>
        <label>
          Background check for new articles
          <select
            value={backgroundPollEnabled()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isOnOff(value)) setBackgroundPollEnabled(value);
            }}
          >
            <option value="on">On (shows a "new articles" toast)</option>
            <option value="off">Off (no background requests)</option>
          </select>
        </label>
      </section>
      <section class="options-card">
        <h2>Reading</h2>
        <label>
          Prefetch next article
          <select
            value={prefetchNextEnabled()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isOnOff(value)) setPrefetchNext(value);
            }}
          >
            <option value="off">Off</option>
            <option value="on">
              On (fetches the next article after you open one)
            </option>
          </select>
        </label>
        <label>
          "Today" view in the sidebar
          <select
            value={todayView()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isOnOff(value)) setTodayView(value);
            }}
          >
            <option value="on">Show (unread from the last 24h)</option>
            <option value="off">Hide</option>
          </select>
        </label>
      </section>
      <Show when={user()}>
        {(account) => (
          <section class="options-card">
            <h2>Account</h2>
            <p>
              {account().name} ({account().email})
            </p>
            <Show when={account().isAdmin}>
              <a
                href="/admin"
                onClick={(event) => {
                  event.preventDefault();
                  props.navigate("/admin");
                }}
              >
                Admin
              </a>
            </Show>
            <button
              type="button"
              disabled={logoutLoading()}
              onClick={() => void logout()}
            >
              {logoutLoading() ? "Logging out…" : "Logout"}
            </button>
          </section>
        )}
      </Show>
      <Show when={sessionMessage()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
      <form class="options-card" onSubmit={submitPassword}>
        <h2>Change password</h2>
        <PasswordInput
          autocomplete="current-password"
          label="Current password"
          onInput={setOldPassword}
        />
        <PasswordInput
          autocomplete="new-password"
          label="New password"
          onInput={setPassword}
        />
        <PasswordInput
          autocomplete="new-password"
          label="Confirm new password"
          onInput={setPasswordConfirm}
        />
        <button disabled={passwordLoading()}>
          {passwordLoading() ? "Changing password…" : "Change password"}
        </button>
        <Show when={passwordMessage()}>
          {(message) => (
            <p role={passwordFailed() ? "alert" : "status"}>{message()}</p>
          )}
        </Show>
      </form>
      <section class="options-card">
        <h2>Reading</h2>
        <label>
          When articles get marked read
          <select
            value={markReadPolicy()}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (isMarkReadPolicy(value)) setMarkReadPolicy(value);
            }}
          >
            <option value="manual">
              Manually only (m key or the Mark read button)
            </option>
            <option value="on-open">
              On open (opening an article marks it read, All view)
            </option>
            <option value="on-scroll-past">
              On scroll-past (a row left visible for a second is marked read)
            </option>
          </select>
        </label>
        <label>
          Remember reading position
          <select
            value={rememberReadingPosition() ? "on" : "off"}
            onChange={(event) =>
              setRememberReadingPosition(event.currentTarget.value === "on")
            }
          >
            <option value="on">
              On (reopening the app resumes where you stopped)
            </option>
            <option value="off">Off (always start at the top)</option>
          </select>
        </label>
        <p>
          Manual only, by default. This reader is built around deleting an
          article once you are done with it, so nothing is marked read behind
          your back unless you ask for it. Automatic marking uses the same
          read-state path as the button, so filtered lists still update the same
          way.
        </p>
      </section>
      <section class="options-card">
        <h2>Keyboard</h2>
        <p>The dashboard is keyboard-first.</p>
        {/* The same DialogHost dialog the `?` shortcut opens; it works on
            this route too because the host is mounted app-wide. */}
        <button type="button" onClick={() => void helpDialog()}>
          Keyboard shortcuts
        </button>
      </section>
      <section class="options-card">
        <h2>Export OPML</h2>
        <p>
          Download every feed subscription as an OPML file any other reader can
          import.
        </p>
        {/* A plain link rather than a fetch: the API is cookie-authenticated,
            so the browser downloads it without the SPA holding the file in
            memory first. */}
        <a class="card-action" download="" href="/api/options/opml">
          Download subscriptions
        </a>
        <p>
          Newsletter subscriptions are not included. Their addresses are minted
          by this instance, so they mean nothing to another reader.
        </p>
      </section>
      <form id="import-opml" class="options-card" onSubmit={submitOpml}>
        <h2>Import OPML</h2>
        <label>
          OPML file
          <input
            accept=".opml,.xml,application/xml,text/xml"
            name="opml"
            type="file"
            required
          />
        </label>
        <button disabled={opmlLoading()}>
          {opmlLoading() ? "Importing…" : "Import"}
        </button>
        <Show when={opmlMessage()}>
          {(message) => (
            <p role={opmlFailed() ? "alert" : "status"}>{message()}</p>
          )}
        </Show>
      </form>
    </main>
  );
}
