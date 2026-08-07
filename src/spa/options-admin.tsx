import { createSignal, For, onMount, Show } from "solid-js";
import type { Static } from "typebox";
import { api } from "./api";
import {
  adminSourcesResponse,
  removedIdResponse,
  sessionResponse,
  successResponse,
} from "../contracts/responses";
import { loginPath } from "./behavior";
import { highContrast, setHighContrast } from "./preferences";

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
        <h2>Accessibility</h2>
        <label>
          <input
            checked={highContrast()}
            type="checkbox"
            onChange={(event) => setHighContrast(event.currentTarget.checked)}
          />
          High-contrast display mode
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
        <label>
          Current password
          <input
            autocomplete="current-password"
            type="password"
            onInput={(event) => setOldPassword(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          New password
          <input
            autocomplete="new-password"
            type="password"
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            autocomplete="new-password"
            type="password"
            onInput={(event) => setPasswordConfirm(event.currentTarget.value)}
            required
          />
        </label>
        <button disabled={passwordLoading()}>
          {passwordLoading() ? "Changing password…" : "Change password"}
        </button>
        <Show when={passwordMessage()}>
          {(message) => (
            <p role={passwordFailed() ? "alert" : "status"}>{message()}</p>
          )}
        </Show>
      </form>
      <form class="options-card" onSubmit={submitOpml}>
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

type AdminSource = Static<typeof adminSourcesResponse>[number];
type SourceSort =
  | "createdAt"
  | "lastAttempt"
  | "lastSuccess"
  | "recentFailures"
  | "subscriberCount"
  | "url";

const ADMIN_COLUMNS: { label: string; sort: SourceSort }[] = [
  { label: "URL", sort: "url" },
  { label: "Subscribers", sort: "subscriberCount" },
  { label: "Failures", sort: "recentFailures" },
  { label: "Last attempt", sort: "lastAttempt" },
  { label: "Last success", sort: "lastSuccess" },
  { label: "Created", sort: "createdAt" },
];

export function Admin(props: {
  handleUnauthorized(cause: unknown): boolean;
  navigate(to: string): void;
}) {
  const [sources, setSources] = createSignal<AdminSource[]>([]);
  const [message, setMessage] = createSignal("");
  const [sortBy, setSortBy] = createSignal<SourceSort>("createdAt");
  const [order, setOrder] = createSignal<"asc" | "desc">("asc");

  async function load() {
    try {
      setSources(
        await api(
          `/admin?sortBy=${sortBy()}&order=${order()}`,
          adminSourcesResponse,
        ),
      );
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setMessage(cause instanceof Error ? cause.message : "Unauthorized");
    }
  }
  onMount(load);

  function sortByColumn(column: SourceSort) {
    if (sortBy() === column) setOrder(order() === "asc" ? "desc" : "asc");
    else {
      setSortBy(column);
      setOrder("asc");
    }
    void load();
  }

  async function replaceUrl(oldUrl: string) {
    const newUrl = prompt("New URL", oldUrl);
    if (!newUrl || newUrl === oldUrl) return;
    try {
      await api("/admin", successResponse, {
        body: JSON.stringify({ newUrl, oldUrl }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await load();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setMessage(
        cause instanceof Error ? cause.message : "Could not update URL.",
      );
    }
  }

  async function removeSource(source: AdminSource) {
    if (
      !confirm(`Delete "${source.url}"? This removes it for every subscriber.`)
    )
      return;
    try {
      await api("/admin", removedIdResponse, {
        body: JSON.stringify({ removeSourceId: source.id }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
      await load();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setMessage(
        cause instanceof Error ? cause.message : "Could not delete source.",
      );
    }
  }

  return (
    <main class="admin-page">
      <h1>Admin</h1>
      <a
        href="/"
        onClick={(event) => {
          event.preventDefault();
          props.navigate("/");
        }}
      >
        Home
      </a>
      <Show when={message()}>{(text) => <p role="alert">{text()}</p>}</Show>
      <div class="admin-table-scroll">
        <table class="admin-table">
          <thead>
            <tr>
              <For each={ADMIN_COLUMNS}>
                {(column) => (
                  <th
                    aria-sort={
                      sortBy() === column.sort
                        ? order() === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() => sortByColumn(column.sort)}
                    >
                      {column.label}
                      {sortBy() === column.sort
                        ? order() === "asc"
                          ? " ▲"
                          : " ▼"
                        : ""}
                    </button>
                  </th>
                )}
              </For>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={sources()}>
              {(source) => (
                <tr>
                  <td>
                    <a href={source.url} rel="noreferrer" target="_blank">
                      {source.url}
                    </a>
                  </td>
                  <td>{source.subscriberCount}</td>
                  <td title={source.recentFailureDetails}>
                    {source.recentFailures}
                  </td>
                  <td>{source.lastAttempt ?? "—"}</td>
                  <td>{source.lastSuccess ?? "—"}</td>
                  <td>{source.createdAt}</td>
                  <td class="admin-table-actions">
                    <button
                      type="button"
                      onClick={() => void replaceUrl(source.url)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeSource(source)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </main>
  );
}
