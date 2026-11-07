import { createSignal, For, onMount, Show } from "solid-js";
import type { Static } from "typebox";
import {
  adminSourcesResponse,
  removedIdResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import {
  type adminQuery,
  removeSourceRequest,
  type sourceSortSchema,
  sourceUrlReplacementRequest,
} from "#shared/contracts/requests.ts";
import { api, ApiError, messageOf } from "./api.ts";
import { confirmDialog, promptDialog } from "./dialog.tsx";
import { formatDate } from "./format-date.ts";
import { PageToolbar } from "./page-toolbar.tsx";

function Timestamp(props: { iso: string | null }) {
  return (
    <Show when={props.iso} fallback="—">
      {(iso) => (
        <time datetime={iso()} title={iso()}>
          {formatDate(iso())}
        </time>
      )}
    </Show>
  );
}

type AdminSource = Static<typeof adminSourcesResponse>[number];
type SourceSort = Static<typeof sourceSortSchema>;
type SortOrder = NonNullable<Static<typeof adminQuery>["order"]>;

const ADMIN_COLUMNS: { label: string; sort: SourceSort }[] = [
  { label: "URL", sort: "url" },
  { label: "Subscribers", sort: "subscriberCount" },
  { label: "Failures", sort: "recentFailures" },
  { label: "Last attempt", sort: "lastAttempt" },
  { label: "Last success", sort: "lastSuccess" },
  { label: "Created", sort: "createdAt" },
];

// "none" is the overwhelming common case (most feeds never advertise a
// hub), so it renders as an em dash rather than a label competing for
// attention with the sources that actually matter here.
const WEBSUB_STATUS_LABELS: Record<AdminSource["websubStatus"], string> = {
  failed: "Failed",
  none: "—",
  pending: "Pending",
  verified: "Live",
};

const FETCH_TRIGGER_LABELS: Record<
  NonNullable<AdminSource["lastFetchTrigger"]>,
  string
> = {
  email: "Email",
  manual: "Manual",
  poll: "Poll",
  "websub-push": "WebSub push",
};

export function Admin(props: {
  handleUnauthorized(cause: unknown): boolean;
  navigate(to: string): void;
}) {
  const [sources, setSources] = createSignal<AdminSource[]>([]);
  const [message, setMessage] = createSignal("");
  // A signed-in account that isn't an admin: the page says whom it is for
  // and shows nothing else.
  const [forbidden, setForbidden] = createSignal(false);
  const [sortBy, setSortBy] = createSignal<SourceSort>("createdAt");
  const [order, setOrder] = createSignal<SortOrder>("asc");

  async function load() {
    const query = new URLSearchParams({ order: order(), sortBy: sortBy() });
    try {
      setMessage("");
      setSources(await api(`/admin?${query}`, adminSourcesResponse));
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      if (cause instanceof ApiError && cause.status === 403) {
        setForbidden(true);
        return;
      }
      setMessage(messageOf(cause, "Could not load the sources."));
    }
  }
  onMount(load);

  // The stacked layout's one sort control: a column and a direction.
  function sortByChoice(value: string) {
    const [column, direction] = value.split(":");
    const choice = ADMIN_COLUMNS.find((item) => item.sort === column);
    if (!choice || (direction !== "asc" && direction !== "desc")) return;
    setSortBy(choice.sort);
    setOrder(direction);
    void load();
  }

  function sortByColumn(column: SourceSort) {
    if (sortBy() === column) setOrder(order() === "asc" ? "desc" : "asc");
    else {
      setSortBy(column);
      setOrder("asc");
    }
    void load();
  }

  async function replaceUrl(source: AdminSource) {
    const oldUrl = source.url;
    const newUrl = await promptDialog("Change feed URL", "New URL", {
      confirmLabel: "Continue",
      initial: oldUrl,
    });
    if (!newUrl || newUrl === oldUrl) return;
    if (
      !(await confirmDialog(
        "Change feed URL?",
        `"${oldUrl}" becomes "${newUrl}" for its ${source.subscriberCount} subscriber(s).`,
        { confirmLabel: "Change URL" },
      ))
    )
      return;
    try {
      await api("/admin", successResponse, {
        json: { newUrl, oldUrl },
        method: "POST",
        request: sourceUrlReplacementRequest,
      });
      await load();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setMessage(messageOf(cause, "Could not update the URL."));
    }
  }

  async function removeSource(source: AdminSource) {
    if (
      !(await confirmDialog(
        "Delete this feed for everyone?",
        `"${source.url}" and its articles are removed for every subscriber.`,
        { confirmLabel: "Delete", danger: true },
      ))
    )
      return;
    try {
      await api("/admin", removedIdResponse, {
        json: { removeSourceId: source.id },
        method: "DELETE",
        request: removeSourceRequest,
      });
      await load();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setMessage(messageOf(cause, "Could not delete the source."));
    }
  }

  return (
    <main class="admin-page">
      <PageToolbar navigate={props.navigate} title="Admin" />
      <Show
        when={!forbidden()}
        fallback={
          <section class="account-result admin-forbidden">
            <p>This page is for administrators.</p>
            <a
              href="/"
              onClick={(event) => {
                event.preventDefault();
                props.navigate("/");
              }}
            >
              Back to your feeds
            </a>
          </section>
        }
      >
        <Show when={message()}>{(text) => <p role="alert">{text()}</p>}</Show>
        {/* Where the table stacks, its header row has no columns to head:
          one control sorts instead (style.css shows one or the other). */}
        <label class="admin-sort">
          Sort by
          <select
            value={`${sortBy()}:${order()}`}
            onChange={(event) => sortByChoice(event.currentTarget.value)}
          >
            <For each={ADMIN_COLUMNS}>
              {(column) => (
                <>
                  <option value={`${column.sort}:asc`}>
                    {column.label}, ascending
                  </option>
                  <option value={`${column.sort}:desc`}>
                    {column.label}, descending
                  </option>
                </>
              )}
            </For>
          </select>
        </label>
        <div
          aria-label="Feed sources"
          class="admin-table-scroll"
          role="region"
          tabindex="0"
        >
          <table aria-label="Feed sources" class="admin-table">
            <thead>
              <tr>
                <For each={ADMIN_COLUMNS}>
                  {(column) => (
                    <th
                      scope="col"
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
                <th scope="col">WebSub</th>
                <th scope="col">Last via</th>
                <th scope="col">Actions</th>
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
                    {/* data-label captions each value where the single-pane
                      layout stacks a row instead of showing the header. */}
                    <td data-label="Subscribers">{source.subscriberCount}</td>
                    <td
                      data-label="Failures"
                      title={source.recentFailureDetails}
                    >
                      {source.recentFailures}
                    </td>
                    <td data-label="Last attempt">
                      <Timestamp iso={source.lastAttempt} />
                    </td>
                    <td data-label="Last success">
                      <Timestamp iso={source.lastSuccess} />
                    </td>
                    <td data-label="Created">
                      <Timestamp iso={source.createdAt} />
                    </td>
                    <td data-label="WebSub">
                      <span
                        class="websub-status"
                        classList={{
                          [`websub-status-${source.websubStatus}`]: true,
                        }}
                      >
                        {WEBSUB_STATUS_LABELS[source.websubStatus]}
                      </span>
                    </td>
                    <td data-label="Last via">
                      {source.lastFetchTrigger
                        ? FETCH_TRIGGER_LABELS[source.lastFetchTrigger]
                        : "—"}
                    </td>
                    <td class="admin-table-actions">
                      {/* The flex row lives inside the cell: a flex <td> is
                        no longer a table cell and breaks the row rules. */}
                      <div>
                        <button
                          type="button"
                          onClick={() => void replaceUrl(source)}
                        >
                          Edit
                        </button>
                        <button
                          class="button-danger-text"
                          type="button"
                          onClick={() => void removeSource(source)}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </main>
  );
}
