import { Show, type JSX } from "solid-js";

// What went wrong underneath a failure's plain sentence, for admins only:
// everyone else gets the sentence alone.
export function FailureDetails(props: {
  admin: boolean;
  reason: string;
  status: number | undefined;
}) {
  return (
    <Show when={props.admin}>
      <details class="failure-details">
        <summary>Details</summary>
        <p>
          {/* The status leads unless the raw reason already names it. */}
          {props.status && !props.reason.includes(String(props.status))
            ? `HTTP ${props.status}. `
            : ""}
          {props.reason || "No reason was recorded."}
        </p>
      </details>
    </Show>
  );
}

export type RetryState = "idle" | "queued" | "sending";

// "Couldn't load" wherever it appears: a feed that stopped updating, above
// its articles or in place of them, and a feed list that did not load.
export function FailingFeedPanel(props: {
  admin: boolean;
  children: JSX.Element;
  details: { reason: string; status: number | undefined } | undefined;
  // A slim line above a list that still has rows, or a block in its place.
  layout: "block" | "notice";
  onEdit?: (() => void) | undefined;
  onRetry(): void;
  retry?: RetryState;
  role?: "alert" | "status";
}) {
  const retry = () => props.retry ?? "idle";
  return (
    <div
      class={
        props.layout === "notice"
          ? "feed-notice"
          : "article-list-empty article-list-failing"
      }
      role={props.role}
    >
      {props.children}
      <div
        class={
          props.layout === "notice" ? "feed-notice-actions" : "form-actions"
        }
      >
        <Show when={props.onEdit}>
          {(edit) => (
            <button type="button" onClick={() => edit()()}>
              Edit feed
            </button>
          )}
        </Show>
        <button
          class="button-primary"
          disabled={retry() !== "idle"}
          type="button"
          onClick={() => props.onRetry()}
        >
          Try again
        </button>
      </div>
      <Show when={retry() === "queued"}>
        <p class="article-list-failing-reason">
          Fetching again. This can take a minute.
        </p>
      </Show>
      <Show when={props.details}>
        {(details) => <FailureDetails admin={props.admin} {...details()} />}
      </Show>
    </div>
  );
}
