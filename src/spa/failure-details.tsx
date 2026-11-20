import { Show, type Element } from "solid-js";

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

export function FailingFeedPanel(props: {
  admin: boolean;
  children: Element;
  details: { reason: string; status: number | undefined } | undefined;
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
