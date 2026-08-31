import { createSignal, For, onMount, Show } from "solid-js";
import type { Static } from "typebox";
import {
  adminSourcesResponse,
  removedIdResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import { api } from "./api.ts";

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
  const [sortBy, setSortBy] = createSignal<SourceSort>("createdAt");
  const [order, setOrder] = createSignal<"asc" | "desc">("asc");

  async function load() {
    try {
      setMessage("");
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
                  <td>{source.subscriberCount}</td>
                  <td title={source.recentFailureDetails}>
                    {source.recentFailures}
                  </td>
                  <td>{source.lastAttempt ?? "—"}</td>
                  <td>{source.lastSuccess ?? "—"}</td>
                  <td>{source.createdAt}</td>
                  <td>
                    <span
                      class="websub-status"
                      classList={{
                        [`websub-status-${source.websubStatus}`]: true,
                      }}
                    >
                      {WEBSUB_STATUS_LABELS[source.websubStatus]}
                    </span>
                  </td>
                  <td>
                    {source.lastFetchTrigger
                      ? FETCH_TRIGGER_LABELS[source.lastFetchTrigger]
                      : "—"}
                  </td>
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
