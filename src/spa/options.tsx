import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Static } from "typebox";
import {
  sessionResponse,
  sessionsResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import { api } from "./api.ts";
import { loginPath } from "./behavior.ts";
import { PasswordInput } from "./password-input.tsx";
import {
  articleSearchBox,
  feedFilterBox,
  isMarkReadPolicy,
  isReaderStep,
  isTheme,
  markReadPolicy,
  mobileListAnchor,
  readerText,
  readerWidth,
  rememberReadingPosition,
  setMarkReadPolicy,
  setArticleSearchBox,
  setFeedFilterBox,
  setMobileListAnchor,
  setReaderText,
  setReaderWidth,
  setRememberReadingPosition,
  setTheme,
  setTodayView,
  theme,
  todayView,
} from "./preferences.ts";
import {
  dateFormat,
  formatDate,
  isDateFormat,
  setDateFormat,
} from "./format-date.ts";
import { describeUserAgent } from "./user-agent.ts";
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

const sections = [
  { id: "reading", label: "Reading" },
  { id: "appearance", label: "Appearance" },
  { id: "signal", label: "New-article signal" },
  { id: "account", label: "Account & security" },
  { id: "data", label: "Data" },
] as const;

type SectionId = (typeof sections)[number]["id"];

// The mobile-layout knob only means anything where the mobile layout exists,
// so its card tracks the same 768px breakpoint the stylesheet's mobile rules
// use and disappears entirely on wider viewports.
const mobileViewQuery = matchMedia("(max-width: 768px)");
const [mobileView, setMobileView] = createSignal(mobileViewQuery.matches);
mobileViewQuery.addEventListener("change", (event) =>
  setMobileView(event.matches),
);

// A hash usually names a section, but anchors into the old card stack must
// keep resolving: the empty-tree guidance links #import-opml, which now
// lives inside the Data section.
function sectionFromHash(hash: string): SectionId {
  if (hash === "#import-opml") return "data";
  const id = hash.slice(1);
  return sections.find((section) => section.id === id)?.id ?? "reading";
}

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
  const [sessions, setSessions] = createSignal<
    Static<typeof sessionsResponse>["sessions"]
  >([]);
  const [sessionsMessage, setSessionsMessage] = createSignal("");
  const [revokingId, setRevokingId] = createSignal<number>();
  const [active, setActive] = createSignal<SectionId>(
    sectionFromHash(location.hash),
  );

  const onHashChange = () => {
    const next = sectionFromHash(location.hash);
    if (next === active()) return;
    setActive(next);
    queueMicrotask(() => {
      // A section id is the nav's own target and lands at the top of the
      // page; any other hash points inside a section (e.g. #import-opml)
      // and must land on that element itself.
      const target = document.querySelector(location.hash);
      if (
        target instanceof HTMLElement &&
        !target.matches(".options-section")
      ) {
        target.scrollIntoView({ block: "start" });
      } else {
        window.scrollTo(0, 0);
      }
    });
  };
  onMount(() => addEventListener("hashchange", onHashChange));
  onCleanup(() => removeEventListener("hashchange", onHashChange));

  onMount(async () => {
    try {
      const session = await api("/session", sessionResponse);
      if (!session.user) {
        props.navigate(loginPath(location.pathname + location.search));
        return;
      }
      setUser(session.user);
      void loadSessions();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionMessage(
        cause instanceof Error ? cause.message : "Could not load session.",
      );
    }
    // The empty-tree guidance links here with a hash; the SPA navigation
    // never scrolls on its own, so honour the target once it is rendered.
    // The initial section was already picked from the same hash above.
    if (location.hash) {
      queueMicrotask(() => {
        document
          .querySelector(location.hash)
          ?.scrollIntoView({ block: "start" });
      });
    }
  });

  async function loadSessions() {
    try {
      const listed = await api("/options/sessions", sessionsResponse);
      setSessions(listed.sessions);
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionsMessage(
        cause instanceof Error ? cause.message : "Could not load sessions.",
      );
    }
  }

  async function revokeSession(id: number) {
    setRevokingId(id);
    setSessionsMessage("");
    try {
      await api(`/options/sessions/${id}`, successResponse, {
        method: "DELETE",
      });
      await loadSessions();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionsMessage(
        cause instanceof Error ? cause.message : "Could not sign out session.",
      );
    } finally {
      setRevokingId(undefined);
    }
  }

  async function revokeOtherSessions() {
    setRevokingId(-1);
    setSessionsMessage("");
    try {
      await api("/options/sessions", successResponse, { method: "DELETE" });
      await loadSessions();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionsMessage(
        cause instanceof Error ? cause.message : "Could not sign out sessions.",
      );
    } finally {
      setRevokingId(undefined);
    }
  }

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
      <nav class="options-nav" aria-label="Options sections">
        <For each={sections}>
          {(section) => (
            <a
              href={`#${section.id}`}
              aria-current={active() === section.id ? "true" : undefined}
            >
              {section.label}
            </a>
          )}
        </For>
      </nav>
      <Show when={sessionMessage()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
      <Show when={active() === "reading"}>
        <section id="reading" class="options-section" aria-label="Reading">
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
            <h2>Marking articles read</h2>
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
                  On scroll-past (a row left visible for a second is marked
                  read)
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
              article once you are done with it, so nothing is marked read
              behind your back unless you ask for it. Automatic marking uses the
              same read-state path as the button, so filtered lists still update
              the same way.
            </p>
          </section>
          <section class="options-card">
            <h2>Prefetch and "Today" view</h2>
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
            <label>
              Feed filter box in the sidebar
              <select
                value={feedFilterBox()}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  if (isOnOff(value)) setFeedFilterBox(value);
                }}
              >
                <option value="on">Show</option>
                <option value="off">Hide</option>
              </select>
            </label>
            <label>
              Article search box
              <select
                value={articleSearchBox()}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  if (isOnOff(value)) setArticleSearchBox(value);
                }}
              >
                <option value="on">Show</option>
                <option value="off">Hide</option>
              </select>
            </label>
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
        </section>
      </Show>
      <Show when={active() === "appearance"}>
        <section
          id="appearance"
          class="options-section"
          aria-label="Appearance"
        >
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
                <option value="high-contrast">
                  High contrast (accessibility)
                </option>
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
          <Show when={mobileView()}>
            <section class="options-card">
              <h2>Mobile layout</h2>
              <label>
                Layout variant
                <select
                  value={mobileListAnchor()}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    if (isOnOff(value)) setMobileListAnchor(value);
                  }}
                >
                  <option value="off">Regular</option>
                  <option value="on">Pull down</option>
                </select>
              </label>
            </section>
          </Show>
        </section>
      </Show>
      <Show when={active() === "signal"}>
        <section
          id="signal"
          class="options-section"
          aria-label="New-article signal"
        >
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
        </section>
      </Show>
      <Show when={active() === "account"}>
        <section
          id="account"
          class="options-section"
          aria-label="Account & security"
        >
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
          <Show when={user()}>
            <section class="options-card">
              <h2>Active sessions</h2>
              <For each={sessions()}>
                {(session) => (
                  <div class="session-row">
                    <span
                      class="session-agent"
                      // The raw header survives as hover detail for
                      // anything the parsed label leaves ambiguous.
                      title={
                        session.userAgent.trim() &&
                        session.userAgent !== "UNKNOWN"
                          ? session.userAgent
                          : undefined
                      }
                    >
                      {describeUserAgent(session.userAgent)}
                    </span>
                    <span class="session-date">
                      {session.current
                        ? "This session"
                        : `Active ${formatDate(session.lastUsedAt)} · expires ${formatDate(session.expiresAt)}`}
                    </span>
                    <Show when={!session.current}>
                      <button
                        type="button"
                        disabled={revokingId() !== undefined}
                        onClick={() => void revokeSession(session.id)}
                      >
                        {revokingId() === session.id
                          ? "Signing out…"
                          : "Sign out"}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={sessions().some((session) => !session.current)}>
                <button
                  type="button"
                  disabled={revokingId() !== undefined}
                  onClick={() => void revokeOtherSessions()}
                >
                  {revokingId() === -1
                    ? "Signing out…"
                    : "Sign out all other sessions"}
                </button>
              </Show>
              <Show when={sessionsMessage()}>
                {(message) => <p role="alert">{message()}</p>}
              </Show>
            </section>
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
        </section>
      </Show>
      <Show when={active() === "data"}>
        <section id="data" class="options-section" aria-label="Data">
          <section class="options-card">
            <h2>Export OPML</h2>
            <p>
              Download every feed subscription as an OPML file any other reader
              can import.
            </p>
            {/* A plain link rather than a fetch: the API is cookie-authenticated,
                so the browser downloads it without the SPA holding the file in
                memory first. */}
            <a class="card-action" download="" href="/api/options/opml">
              Download subscriptions
            </a>
            <p>
              Newsletter subscriptions are not included. Their addresses are
              minted by this instance, so they mean nothing to another reader.
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
        </section>
      </Show>
    </main>
  );
}
