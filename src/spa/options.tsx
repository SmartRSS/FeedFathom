import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import type { Static } from "typebox";
import {
  sessionResponse,
  sessionsResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import { todayWindowHours } from "#shared/contracts/limits.ts";
import {
  opmlUploadField,
  passwordRequest,
} from "#shared/contracts/requests.ts";
import { type AccountField, accountFieldErrors } from "./account-validation.ts";
import { api, messageOf } from "./api.ts";
import { loginPath } from "./routes.ts";
import { PasswordInput } from "./password-input.tsx";
import {
  articleSearchBox,
  backgroundPoll,
  dateFormat,
  density,
  enclosuresOpen,
  feedFilterBox,
  markReadPolicy,
  mobileListAnchor,
  offlineUnread,
  type Preference,
  prefetchNext,
  readerText,
  readerWidth,
  rememberReadingPosition,
  type Setting,
  theme,
  todayView,
  unreadBadge,
  youtubeHost,
  youtubeLoad,
} from "./preferences.ts";
import { formatDate } from "./format-date.ts";
import {
  forgetAccountData,
  offlineArticleLimit,
  offlineArticleMaxAgeDays,
} from "./sw-protocol.ts";
import { describeUserAgent } from "./user-agent.ts";
import { helpDialog } from "./dialog.tsx";
import { PageToolbar } from "./page-toolbar.tsx";

type SessionUser = NonNullable<Static<typeof sessionResponse>["user"]>;

const sections = [
  { id: "reading", label: "Reading" },
  { id: "lists", label: "Lists" },
  { id: "appearance", label: "Appearance" },
  { id: "keyboard", label: "Keyboard" },
  { id: "import-export", label: "Import & export" },
  { id: "account", label: "Account" },
] as const;

type SectionId = (typeof sections)[number]["id"];

const sectionAliases: Record<string, SectionId> = {
  data: "import-export",
  "import-opml": "import-export",
  signal: "lists",
};

function sectionFromHash(hash: string): SectionId {
  const id = hash.slice(1);
  const section = sections.find((candidate) => candidate.id === id);
  return section?.id ?? sectionAliases[id] ?? "reading";
}

function PreferenceCheckbox(props: {
  hint?: string;
  label: string;
  preference: Preference<boolean>;
}) {
  const hintId = createUniqueId();
  return (
    <div class="options-field">
      <label class="options-check">
        <input
          aria-describedby={props.hint ? hintId : undefined}
          checked={props.preference.get()}
          type="checkbox"
          onChange={(event) =>
            props.preference.set(event.currentTarget.checked)
          }
        />
        <span>{props.label}</span>
      </label>
      <Show when={props.hint}>
        <p class="options-hint" id={hintId}>
          {props.hint}
        </p>
      </Show>
    </div>
  );
}

function PreferenceSelect<T extends boolean | string>(props: {
  hint?: string;
  label: string;
  preference: Setting<T>;
}) {
  const hintId = createUniqueId();
  return (
    <div class="options-field">
      <label>
        {props.label}
        <select
          aria-describedby={props.hint ? hintId : undefined}
          value={String(props.preference.get())}
          onChange={(event) => {
            const { value } = event.currentTarget;
            const choice = props.preference.choices.find(
              ([key]) => String(key) === value,
            );
            if (choice) props.preference.set(choice[0]);
          }}
        >
          <For each={props.preference.choices}>
            {([value, label]) => <option value={String(value)}>{label}</option>}
          </For>
        </select>
      </label>
      <Show when={props.hint}>
        <p class="options-hint" id={hintId}>
          {props.hint}
        </p>
      </Show>
    </div>
  );
}

function Scope(props: { children: string }) {
  return <p class="options-scope">{props.children}</p>;
}
const DEVICE_SCOPE = "Saved on this device only.";

function scrollToHashTarget() {
  const target = document.getElementById(location.hash.slice(1));
  if (target instanceof HTMLElement && !target.matches(".options-section")) {
    target.scrollIntoView({ block: "start" });
  } else {
    window.scrollTo(0, 0);
  }
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
  const [passwordErrors, setPasswordErrors] = createSignal<
    Partial<Record<AccountField, string>>
  >({});
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
    queueMicrotask(scrollToHashTarget);
  };
  onSettled(() => {
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  });

  onSettled(() => void loadAccount());
  async function loadAccount() {
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
      setSessionMessage(messageOf(cause, "Could not load your account."));
    }
    if (location.hash) queueMicrotask(scrollToHashTarget);
  }

  async function loadSessions() {
    try {
      const listed = await api("/options/sessions", sessionsResponse);
      setSessions(listed.sessions);
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionsMessage(messageOf(cause, "Could not load your sessions."));
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
      setSessionsMessage(messageOf(cause, "Could not sign out that session."));
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
        messageOf(cause, "Could not sign out the other sessions."),
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
      await forgetAccountData(true);
      props.navigate("/login");
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setSessionMessage(messageOf(cause, "Could not log out."));
      setLogoutLoading(false);
    }
  }

  async function submitPassword(event: Event) {
    event.preventDefault();
    if (passwordLoading()) return;
    setPasswordMessage("");
    const errors = accountFieldErrors({
      confirm: passwordConfirm(),
      password: password(),
    });
    setPasswordErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPasswordLoading(true);
    try {
      await api("/options/password", successResponse, {
        json: {
          oldPassword: oldPassword(),
          password1: password(),
          password2: passwordConfirm(),
        },
        method: "POST",
        request: passwordRequest,
      });
      setPasswordFailed(false);
      setPasswordMessage("Password changed.");
      void loadSessions();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setPasswordFailed(true);
      setPasswordMessage(messageOf(cause, "Could not change your password."));
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
      setOpmlMessage(messageOf(cause, "Could not import the OPML file."));
    } finally {
      setOpmlLoading(false);
    }
  }

  return (
    <>
      <PageToolbar navigate={props.navigate} title="Options" />
      <main class="options-page">
        <nav class="options-nav" aria-label="Options sections">
          <For each={sections}>
            {(section) => (
              <a
                class={
                  section.id === "keyboard" ? "options-keyboard" : undefined
                }
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
            <Scope>{DEVICE_SCOPE}</Scope>
            <section class="options-card">
              <h2>Marking as read</h2>
              <PreferenceSelect
                label="Mark articles read"
                preference={markReadPolicy}
                hint="Nothing is marked read unless you choose it here: FeedFathom is built around deleting an article once you are done with it."
              />
              <PreferenceCheckbox
                label="Reopen where you left off"
                preference={rememberReadingPosition}
                hint="When off, the app always starts at the top."
              />
            </section>
            <section class="options-card">
              <h2>Attachments and video</h2>
              <PreferenceSelect
                label="Expand attachments"
                preference={enclosuresOpen}
              />
              <PreferenceSelect
                label="Load YouTube videos"
                preference={youtubeLoad}
              />
              <PreferenceSelect
                label="Play YouTube from"
                preference={youtubeHost}
              />
            </section>
            <section class="options-card">
              <h2>Loading ahead</h2>
              <PreferenceCheckbox
                label="Prefetch the next article"
                preference={prefetchNext}
                hint="Fetches the next article while you read this one."
              />
              <PreferenceCheckbox
                label="Download unread articles for offline reading"
                preference={offlineUnread}
                hint={`Keeps up to ${offlineArticleLimit} unread articles from the last ${offlineArticleMaxAgeDays} days.`}
              />
            </section>
          </section>
        </Show>
        <Show when={active() === "lists"}>
          <section id="lists" class="options-section" aria-label="Lists">
            <Scope>{DEVICE_SCOPE}</Scope>
            <section class="options-card">
              <h2>Sidebar and article list</h2>
              <PreferenceCheckbox
                label="Show the Today view"
                preference={todayView}
                hint={`Unread articles from the last ${todayWindowHours} hours, at the top of the sidebar.`}
              />
              <PreferenceCheckbox
                label="Show the feed filter box"
                preference={feedFilterBox}
              />
              <PreferenceCheckbox
                label="Show the article search box"
                preference={articleSearchBox}
              />
            </section>
            <section class="options-card">
              <h2>New articles</h2>
              <PreferenceCheckbox
                label="Check for new articles in the background"
                preference={backgroundPoll}
                hint="Shows a notice when new articles arrive. When off, nothing is requested in the background."
              />
              <PreferenceCheckbox
                label="Show the unread count in the tab title"
                preference={unreadBadge}
              />
            </section>
          </section>
        </Show>
        <Show when={active() === "appearance"}>
          <section
            id="appearance"
            class="options-section"
            aria-label="Appearance"
          >
            <Scope>{DEVICE_SCOPE}</Scope>
            <section class="options-card">
              <h2>Display</h2>
              <PreferenceSelect label="Theme" preference={theme} />
              <PreferenceSelect
                label="Density"
                preference={density}
                hint="Compact uses smaller rows, controls and spacing, in any theme."
              />
              <PreferenceSelect label="Date format" preference={dateFormat} />
            </section>
            <section class="options-card">
              <h2>Article text</h2>
              <PreferenceSelect label="Text size" preference={readerText} />
              <PreferenceSelect label="Line width" preference={readerWidth} />
            </section>
            <section class="options-card options-mobile-layout">
              <h2>Narrow screens</h2>
              <PreferenceSelect
                label="Toolbars"
                preference={mobileListAnchor}
                hint="At the bottom, a short article list moves down to meet them."
              />
            </section>
          </section>
        </Show>
        <Show when={active() === "keyboard"}>
          <section id="keyboard" class="options-section" aria-label="Keyboard">
            <section class="options-card">
              <h2>Keyboard shortcuts</h2>
              <p>
                Every action on the dashboard has a key. Press ? there to see
                them all.
              </p>
              <button type="button" onClick={() => void helpDialog()}>
                Show keyboard shortcuts
              </button>
            </section>
          </section>
        </Show>
        <Show when={active() === "import-export"}>
          <section
            id="import-export"
            class="options-section"
            aria-label="Import & export"
          >
            <Scope>
              Imports add to your account, so they show on every device.
            </Scope>
            <form id="import-opml" class="options-card" onSubmit={submitOpml}>
              <h2>Import OPML</h2>
              <label>
                OPML file
                <input
                  accept=".opml,.xml,application/xml,text/xml"
                  name={opmlUploadField}
                  type="file"
                  required
                />
              </label>
              <button class="button-primary" disabled={opmlLoading()}>
                {opmlLoading() ? "Importing…" : "Import"}
              </button>
              <Show when={opmlMessage()}>
                {(message) => (
                  <p role={opmlFailed() ? "alert" : "status"}>{message()}</p>
                )}
              </Show>
            </form>
            <section class="options-card">
              <h2>Export OPML</h2>
              <p>
                Download every feed subscription as an OPML file any other
                reader can import.
              </p>
              <a class="card-action" download="" href="/api/options/opml">
                Download subscriptions
              </a>
              <p class="options-hint">
                Newsletter subscriptions are left out. Their addresses belong to
                this server, so they mean nothing to another reader.
              </p>
            </section>
          </section>
        </Show>
        <Show when={active() === "account"}>
          <section id="account" class="options-section" aria-label="Account">
            <Scope>Applies to your account on every device.</Scope>
            <Show when={user()}>
              {(account) => (
                <section class="options-card">
                  <h2>Signed in as</h2>
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
                        title={
                          session.userAgent?.trim()
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
                value={oldPassword()}
                onInput={setOldPassword}
              />
              <PasswordInput
                autocomplete="new-password"
                error={passwordErrors().password}
                label="New password"
                value={password()}
                onInput={setPassword}
              />
              <PasswordInput
                autocomplete="new-password"
                error={passwordErrors().confirm}
                label="Confirm new password"
                value={passwordConfirm()}
                onInput={setPasswordConfirm}
              />
              <button class="button-primary" disabled={passwordLoading()}>
                {passwordLoading() ? "Changing password…" : "Change password"}
              </button>
              <Show when={passwordMessage()}>
                {(message) => (
                  <p role={passwordFailed() ? "alert" : "status"}>
                    {message()}
                  </p>
                )}
              </Show>
            </form>
          </section>
        </Show>
      </main>
    </>
  );
}
