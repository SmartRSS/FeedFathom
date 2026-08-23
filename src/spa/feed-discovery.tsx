import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  foldersResponse,
  foundFeedsResponse,
  previewResponse,
  subscriptionResponse,
  updatedSourceResponse,
  type Folder,
  type FoundFeed,
  type PreviewArticle,
} from "#shared/contracts/responses.ts";
import type { DashboardPane } from "./behavior.ts";
import { api } from "./api.ts";
import {
  clickSelectsArticle,
  initialPreviewSelection,
  websiteValidationMessage,
  withScheme,
} from "./discovery-behavior.ts";
import { Icon } from "./icon.tsx";
import backRaw from "./assets/icons/Arrows/arrow-left-fill.svg?raw";

export function BackButton(props: { backPane(): void }) {
  return (
    <button aria-label="back" class="only-mobile" onClick={props.backPane}>
      <Icon raw={backRaw} />
    </button>
  );
}

export function FeedDiscovery(props: {
  backPane(): void;
  close(): void;
  // Present only when editing an existing subscription instead of adding a
  // new one: reuses this same panel (title/folder are editable either way)
  // but locks the feed/home URL fields and skips the website-search/preview
  // steps entirely, since those don't apply to an already-subscribed feed.
  editing?:
    | {
        homeUrl: string;
        name: string;
        parentUid: string | undefined;
        uid: string;
        xmlUrl: string;
      }
    | undefined;
  focusPane(next: DashboardPane): void;
  handleUnauthorized(cause: unknown): boolean;
  initialFeedUrl?: string | undefined;
  pane(): DashboardPane;
  saved(sourceId: number): void;
}) {
  const [link, setLink] = createSignal("");
  const [feedUrl, setFeedUrl] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [folderId, setFolderId] = createSignal("");
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [feeds, setFeeds] = createSignal<FoundFeed[]>([]);
  const [articles, setArticles] = createSignal<PreviewArticle[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal<number>();
  const [loading, setLoading] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [startupMessage, setStartupMessage] = createSignal("");
  const reportError = (cause: unknown, fallback: string) => {
    if (props.handleUnauthorized(cause)) return;
    setMessage(cause instanceof Error ? cause.message : fallback);
  };
  const selectedArticle = () => {
    const index = selectedIndex();
    return index === undefined ? undefined : articles()[index];
  };
  let latestRequest = 0;
  let disposed = false;
  let websiteInput!: HTMLInputElement;
  onCleanup(() => {
    disposed = true;
    latestRequest++;
  });

  onMount(() => {
    if (props.editing) {
      setFeedUrl(props.editing.xmlUrl);
      setLink(props.editing.homeUrl);
      setTitle(props.editing.name);
    } else {
      const initialFeedUrl = props.initialFeedUrl;
      if (initialFeedUrl) {
        setFeedUrl(initialFeedUrl);
        try {
          const url = new URL(initialFeedUrl);
          if (url.protocol === "http:" || url.protocol === "https:")
            void preview(initialFeedUrl);
        } catch {}
      }
    }
    void (async () => {
      try {
        const loadedFolders = await api("/folders", foldersResponse);
        if (disposed) return;
        setFolders(loadedFolders);
        // Set together with (not before) the folders that just loaded --
        // assigning the <select>'s value while its matching <option> doesn't
        // exist yet has nothing to select against, and Solid doesn't
        // re-apply that binding just because sibling <option>s appear later,
        // so it would silently fall back to "No parent" instead.
        if (props.editing) setFolderId(props.editing.parentUid ?? "");
      } catch (cause) {
        if (disposed || props.handleUnauthorized(cause)) return;
        setStartupMessage(
          cause instanceof Error ? cause.message : "Could not load folders.",
        );
      }
    })();
  });

  function websiteIsValid() {
    if (!websiteInput) return false;
    websiteInput.setCustomValidity(websiteValidationMessage(link()));
    return websiteInput.reportValidity();
  }

  async function findFeeds() {
    const normalizedLink = withScheme(link());
    if (normalizedLink !== link()) setLink(normalizedLink);
    if (!websiteIsValid()) return;
    const request = ++latestRequest;
    setLoading(true);
    setProgress("Finding feeds…");
    try {
      const found = await api(
        `/find?link=${encodeURIComponent(normalizedLink)}`,
        foundFeedsResponse,
      );
      if (request !== latestRequest) return;
      setFeeds(found);
      setMessage("");
    } catch (cause) {
      if (request === latestRequest) reportError(cause, "No feeds found");
    } finally {
      if (request === latestRequest) {
        setLoading(false);
        setProgress("");
      }
    }
  }

  async function preview(url = feedUrl()) {
    const request = ++latestRequest;
    setLoading(true);
    setProgress("Loading preview…");
    setArticles([]);
    setSelectedIndex(undefined);
    setTitle("");
    try {
      const result = await api(
        `/preview?feedUrl=${encodeURIComponent(withScheme(url))}`,
        previewResponse,
      );
      if (request !== latestRequest) return;
      setFeedUrl(result.feedUrl);
      setLink(result.link ?? "");
      setTitle(result.title);
      setArticles(result.articles);
      setSelectedIndex(initialPreviewSelection(result.articles.length));
      setFeeds([]);
      setMessage("");
      props.focusPane("articles");
    } catch (cause) {
      if (request === latestRequest) reportError(cause, "Preview failed");
    } finally {
      if (request === latestRequest) {
        setLoading(false);
        setProgress("");
      }
    }
  }

  function selectPreviewArticle(index: number, event: MouseEvent) {
    if (!clickSelectsArticle(event)) return;
    event.preventDefault();
    setSelectedIndex(index);
    props.focusPane("reader");
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(feedUrl());
      setMessage("Address copied.");
    } catch {
      setMessage("Copy denied. Copy the address manually.");
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    const editing = props.editing;
    setLoading(true);
    setProgress(editing ? "Saving…" : "Subscribing…");
    try {
      const result = editing
        ? await api("/source", updatedSourceResponse, {
            body: JSON.stringify({
              sourceFolder: folderId() ? Number(folderId()) : null,
              sourceId: Number(editing.uid),
              sourceName: title(),
            }),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
          })
        : await api("/subscribe", subscriptionResponse, {
            body: JSON.stringify({
              sourceFolder: folderId() ? Number(folderId()) : null,
              sourceName: title(),
              sourceUrl: withScheme(feedUrl()),
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
      await props.saved(result.sourceId);
    } catch (cause) {
      reportError(
        cause,
        editing ? "Could not save changes" : "Could not subscribe",
      );
    } finally {
      setLoading(false);
      setProgress("");
    }
  }

  return (
    <>
      <Show when={message() || startupMessage()}>
        {(text) => (
          <p class="dashboard-alert" role="alert">
            {text()}
          </p>
        )}
      </Show>
      <aside
        class="dashboard-pane sources-pane"
        classList={{ "focused-pane": props.pane() === "sources" }}
      >
        <form class="feed-discovery-form" onSubmit={submit}>
          <h2>{props.editing ? "Edit feed" : "Discover feed"}</h2>
          <label>
            Website
            {/* Same shared-row lock as Feed URL below when editing -- see
                that field's comment. */}
            <input
              ref={websiteInput}
              disabled={!!props.editing}
              title={
                props.editing
                  ? "Shared with every subscriber to this feed"
                  : undefined
              }
              type="url"
              value={link()}
              onInput={(event) => {
                event.currentTarget.setCustomValidity("");
                setLink(event.currentTarget.value);
              }}
            />
          </label>
          <Show when={!props.editing}>
            <button
              type="button"
              disabled={loading() || !link()}
              onClick={() => void findFeeds()}
            >
              Find feeds
            </button>
            <Show when={feeds().length}>
              <div class="found-feeds">
                <For each={feeds()}>
                  {(item) => (
                    <button
                      type="button"
                      onClick={() => void preview(item.url)}
                    >
                      <strong>
                        {item.title}
                        <Show when={item.websub}>
                          <span
                            class="websub-badge"
                            title="This feed pushes updates instantly via WebSub instead of waiting to be polled."
                          >
                            WebSub
                          </span>
                        </Show>
                      </strong>
                      <span>{item.url}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
          <label>
            Feed URL
            {/* Shared/deduplicated across every subscriber to this feed
                (see sources_url_unique) -- locked here so editing can't
                silently repoint everyone else's subscription too.
                Unsubscribing and subscribing to a different URL is the
                supported way to point at a different feed. */}
            <input
              disabled={!!props.editing}
              title={
                props.editing
                  ? "Shared with every subscriber to this feed"
                  : undefined
              }
              value={feedUrl()}
              onInput={(event) => setFeedUrl(event.currentTarget.value)}
            />
          </label>
          <Show when={!props.editing}>
            <Show when={feedUrl().includes("@")}>
              <button type="button" onClick={() => void copyAddress()}>
                Copy address
              </button>
            </Show>
            <Show when={!feedUrl().includes("@")}>
              <button
                type="button"
                disabled={loading() || !feedUrl()}
                onClick={() => void preview()}
              >
                Load preview
              </button>
            </Show>
          </Show>
          <label>
            Title
            <input
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            Folder
            <select
              value={folderId()}
              onChange={(event) => setFolderId(event.currentTarget.value)}
            >
              <option value="">No parent</option>
              <For each={folders()}>
                {(item) => <option value={item.id}>{item.name}</option>}
              </For>
            </select>
          </label>
          <Show when={progress()}>
            {(text) => (
              <p class="progress" role="status">
                <span class="spinner" />
                {text()}
              </p>
            )}
          </Show>
          <div class="form-actions">
            <button type="button" onClick={props.close}>
              Cancel
            </button>
            <button disabled={loading() || !feedUrl() || !title()}>
              {props.editing ? "Save" : "Subscribe"}
            </button>
          </div>
        </form>
      </aside>
      <section
        class="dashboard-pane articles-pane"
        classList={{ "focused-pane": props.pane() === "articles" }}
      >
        <div class="toolbar">
          <BackButton backPane={props.backPane} />
          <strong>{title() || "Preview"}</strong>
          <span />
        </div>
        <div class="article-list">
          <Show
            when={articles().length}
            fallback={
              <p class="empty-pane">
                {props.editing
                  ? "Editing an existing subscription."
                  : "Load a feed to preview its articles."}
              </p>
            }
          >
            <For each={articles()}>
              {(article, index) => (
                <a
                  class="article"
                  classList={{ selected: selectedIndex() === index() }}
                  href={article.url || undefined}
                  onClick={(event) => selectPreviewArticle(index(), event)}
                >
                  <span class="title">{article.title}</span>
                  <span class="details">
                    <span>{article.author}</span>
                    <time>
                      {new Date(article.publishedAt).toLocaleString()}
                    </time>
                  </span>
                </a>
              )}
            </For>
          </Show>
        </div>
      </section>
      <article
        class="dashboard-pane reader-pane"
        classList={{ "focused-pane": props.pane() === "reader" }}
      >
        <div class="toolbar">
          <BackButton backPane={props.backPane} />
          <span />
        </div>
        <div class="reader">
          <Show
            when={selectedArticle()}
            fallback={<p>Select a preview article.</p>}
          >
            {(item) => (
              <>
                <h1>{item().title}</h1>
                <Show when={item().url}>
                  <a href={item().url}>Original</a>
                </Show>
                <div innerHTML={item().content} />
              </>
            )}
          </Show>
        </div>
      </article>
    </>
  );
}
