import {
  createEffect,
  createSignal,
  flush,
  For,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import {
  foldersResponse,
  foundFeedsResponse,
  previewResponse,
  subscriptionResponse,
  successResponse,
  updatedSourceResponse,
  type Folder,
  type FoundFeed,
  type PreviewArticle,
} from "#shared/contracts/responses.ts";
import {
  newsletterAddressRequest,
  subscribeRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import { isEmailAddress, isWebUrl } from "#shared/validation/address-shape.ts";
import { previewPath, previewPathname } from "#shared/contracts/spa-routes.ts";
import { readerHidden, type DashboardPane } from "./panes.ts";
import { Enclosures } from "./enclosures.tsx";
import { api, ApiError, failureDetails, messageOf } from "./api.ts";
import { ArticleMarkup } from "./article-markup.tsx";
import { FailureDetails } from "./failure-details.tsx";
import { websiteValidationMessage, withScheme } from "./discovery-behavior.ts";
import {
  isNewsletterAddress,
  newsletterAddress,
} from "#shared/util/newsletter-address.ts";
import { formatDate } from "./format-date.ts";
import { ReaderHeader } from "./reader-header.tsx";
import { BackButton } from "./page-toolbar.tsx";

export function FeedDiscovery(props: {
  admin: boolean;
  backPane(): void;
  close(): void;
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
  initialFolder?: string | undefined;
  initialNewsletter?: boolean;
  mailDomain: string | undefined;
  pane(): DashboardPane;
  saved(sourceId: number): void;
}) {
  const [link, setLink] = createSignal(
    untrack(() => props.editing?.homeUrl ?? ""),
  );
  const [feedUrl, setFeedUrl] = createSignal(
    untrack(() => props.editing?.xmlUrl ?? props.initialFeedUrl ?? ""),
  );
  const isEmail = () => isEmailAddress(feedUrl());
  const [title, setTitle] = createSignal(
    untrack(() => props.editing?.name ?? ""),
  );
  const [folderId, setFolderId] = createSignal("");
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [feeds, setFeeds] = createSignal<FoundFeed[]>([]);
  const [articles, setArticles] = createSignal<PreviewArticle[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal<number>();
  const [loading, setLoading] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [previewError, setPreviewError] = createSignal("");
  const [previewDetails, setPreviewDetails] =
    createSignal<ReturnType<typeof failureDetails>>();
  const [startupMessage, setStartupMessage] = createSignal("");
  const reportError = (cause: unknown, fallback: string) => {
    if (props.handleUnauthorized(cause)) return;
    setMessage(messageOf(cause, fallback));
  };
  const selectedArticle = () => {
    const index = selectedIndex();
    return index === undefined ? undefined : articles()[index];
  };
  let requests = new AbortController();
  const startRequest = () => {
    requests.abort();
    requests = new AbortController();
    return requests.signal;
  };
  let disposed = false;
  let websiteInput!: HTMLInputElement;
  let form!: HTMLFormElement;
  onCleanup(() => {
    disposed = true;
    requests.abort();
  });

  onSettled(() => {
    form
      .querySelector<HTMLInputElement>("input:not([disabled], [readonly])")
      ?.focus();
    const initialFeedUrl = props.initialFeedUrl;
    if (!props.editing && initialFeedUrl && isWebUrl(initialFeedUrl))
      void preview(initialFeedUrl);
    void (async () => {
      try {
        const loadedFolders = await api("/folders", foldersResponse);
        if (disposed) return;
        setFolders(loadedFolders);
        setFolderId(
          (props.editing ? props.editing.parentUid : props.initialFolder) ?? "",
        );
      } catch (cause) {
        if (disposed || props.handleUnauthorized(cause)) return;
        setStartupMessage(messageOf(cause, "Could not load your folders."));
      }
    })();
  });

  createEffect(
    () => props.mailDomain,
    (domain) =>
      untrack(() => {
        if (!domain || props.editing) return;
        if (props.initialNewsletter && !feedUrl())
          void mintNewsletterAddress(domain).then(reportUnreserved);
        else if (isNewsletterAddress(feedUrl(), domain))
          void reserveNewsletterAddress(feedUrl()).then(reportUnreserved);
      }),
  );

  function websiteIsValid() {
    if (!websiteInput) return false;
    websiteInput.setCustomValidity(websiteValidationMessage(link()));
    return websiteInput.reportValidity();
  }

  async function findFeeds() {
    const normalizedLink = withScheme(link());
    if (normalizedLink !== link()) {
      setLink(normalizedLink);
      flush();
    }
    if (!websiteIsValid()) return;
    const signal = startRequest();
    setLoading(true);
    setProgress("Finding feeds…");
    try {
      const found = await api(
        `/find?link=${encodeURIComponent(normalizedLink)}`,
        foundFeedsResponse,
        { raceWhenStalled: false, signal },
      );
      if (signal.aborted) return;
      setFeeds(found);
      setMessage("");
    } catch (cause) {
      if (!signal.aborted) reportError(cause, "Could not look for feeds.");
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setProgress("");
      }
    }
  }

  async function preview(url = feedUrl()) {
    const signal = startRequest();
    setLoading(true);
    setProgress("Loading preview…");
    setArticles([]);
    setTruncated(false);
    setSelectedIndex(undefined);
    setTitle("");
    setPreviewError("");
    try {
      const result = await api(
        `/preview?feedUrl=${encodeURIComponent(withScheme(url))}`,
        previewResponse,
        { raceWhenStalled: false, signal },
      );
      if (signal.aborted) return;
      setFeedUrl(result.feedUrl);
      setLink(result.link ?? "");
      setTitle(result.title);
      setArticles(result.articles);
      setTruncated(result.truncated ?? false);
      setSelectedIndex(
        result.articles.length && !readerHidden() ? 0 : undefined,
      );
      setFeeds([]);
      setMessage("");
      props.focusPane("articles");
    } catch (cause) {
      if (signal.aborted || props.handleUnauthorized(cause)) return;
      setPreviewDetails(failureDetails(cause));
      setPreviewError(messageOf(cause, "Could not load this feed."));
      props.focusPane("sources");
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setProgress("");
      }
    }
  }

  function selectPreviewArticle(index: number, event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    setSelectedIndex(index);
    props.focusPane("reader");
  }

  function mintNewsletterAddress(domain: string) {
    const address = newsletterAddress(domain);
    setFeedUrl(address);
    if (location.pathname === previewPathname)
      history.replaceState(
        history.state,
        "",
        previewPath({ feedUrl: address }),
      );
    return reserveNewsletterAddress(address);
  }

  async function reserveNewsletterAddress(address: string) {
    try {
      await api("/newsletter-address", successResponse, {
        json: { address },
        method: "POST",
        request: newsletterAddressRequest,
      });
      return true;
    } catch (cause) {
      return disposed || props.handleUnauthorized(cause);
    }
  }

  function reportUnreserved(reserved: boolean) {
    if (!reserved)
      setMessage(
        "Address not reserved: mail sent to it bounces until you subscribe. Generate another or subscribe now.",
      );
  }

  async function useNewsletterAddress() {
    const reserved = mintNewsletterAddress(props.mailDomain ?? "");
    setArticles([]);
    setSelectedIndex(undefined);
    flush();
    await copyAddress();
    reportUnreserved(await reserved);
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
            json: {
              sourceFolder: folderId() ? Number(folderId()) : null,
              sourceId: Number(editing.uid),
              sourceName: title(),
            },
            method: "PATCH",
            request: updateSourceRequest,
          })
        : await api("/subscribe", subscriptionResponse, {
            json: {
              sourceFolder: folderId() ? Number(folderId()) : null,
              sourceName: title(),
              sourceUrl: withScheme(feedUrl()),
            },
            method: "POST",
            request: subscribeRequest,
          });
      await props.saved(result.sourceId);
    } catch (cause) {
      if (!editing && cause instanceof ApiError && cause.status === 422) {
        setMessage(
          "Could not subscribe: not a valid feed URL or a newsletter address generated here.",
        );
        return;
      }
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
        aria-label={props.editing ? "Edit feed" : "Discover feed"}
        class={[
          "dashboard-pane sources-pane",
          {
            "discovery-wide": !articles().length,
            "focused-pane": props.pane() === "sources",
          },
        ]}
      >
        <div class="toolbar">
          <BackButton always backPane={props.close} />
          <h2 class="toolbar-title">
            {props.editing ? "Edit feed" : "Discover feed"}
          </h2>
        </div>
        <form
          class="feed-discovery-form"
          onKeyDown={(event) => {
            if (event.key === "Escape") props.close();
          }}
          onSubmit={submit}
          ref={form}
        >
          <label>
            Website
            <input
              ref={websiteInput}
              readonly={!!props.editing}
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
              class="field-action"
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
            {isEmail() ? "Email address" : "Feed URL"}
            <input
              aria-describedby={previewError() ? "feed-url-error" : undefined}
              aria-invalid={previewError() ? "true" : undefined}
              readonly={!!props.editing}
              title={
                props.editing
                  ? "Shared with every subscriber to this feed"
                  : undefined
              }
              value={feedUrl()}
              onInput={(event) => {
                setPreviewError("");
                setFeedUrl(event.currentTarget.value);
              }}
            />
          </label>
          <Show when={previewError()}>
            {(text) => (
              <p class="field-error" id="feed-url-error" role="alert">
                {text()}
              </p>
            )}
          </Show>
          <Show when={previewError() ? previewDetails() : undefined}>
            {(details) => <FailureDetails admin={props.admin} {...details()} />}
          </Show>
          <Show when={!props.editing && !isEmail()}>
            <button
              class={[
                "field-action",
                { "button-primary": Boolean(feedUrl()) && !title() },
              ]}
              type="button"
              disabled={loading() || !feedUrl()}
              onClick={() => void preview()}
            >
              Load preview
            </button>
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
              <option value="">No folder</option>
              <For each={folders()}>
                {(item) => <option value={item.id}>{item.name}</option>}
              </For>
            </select>
          </label>
          <Show
            when={!props.editing && (Boolean(props.mailDomain) || isEmail())}
          >
            <fieldset class="discovery-email">
              <legend>Subscribe by email</legend>
              <div class="discovery-email-actions">
                <Show when={props.mailDomain}>
                  <button
                    type="button"
                    disabled={loading()}
                    title="Mail sent to this address becomes articles in this feed."
                    onClick={() => void useNewsletterAddress()}
                  >
                    Generate email address
                  </button>
                </Show>
                <Show when={isEmail()}>
                  <button type="button" onClick={() => void copyAddress()}>
                    Copy address
                  </button>
                </Show>
              </div>
            </fieldset>
          </Show>
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
            <button
              class="button-primary"
              disabled={loading() || !feedUrl() || !title()}
            >
              {props.editing ? "Save" : "Subscribe"}
            </button>
          </div>
        </form>
      </aside>
      <Show when={articles().length}>
        <section
          aria-label="Preview articles"
          class={[
            "dashboard-pane articles-pane",
            { "focused-pane": props.pane() === "articles" },
          ]}
        >
          <div class="toolbar">
            <BackButton backPane={props.backPane} />
            <strong>{title() || "Preview"}</strong>
            <span />
          </div>
          <div class="article-list">
            <div role="list">
              <For each={articles()}>
                {(article, index) => (
                  <div role="listitem">
                    <a
                      aria-current={
                        selectedIndex() === index() ? "true" : undefined
                      }
                      class={[
                        "article",
                        { selected: selectedIndex() === index() },
                      ]}
                      href={article.url || undefined}
                      onClick={(event) => selectPreviewArticle(index(), event)}
                    >
                      <span class="title">{article.title}</span>
                      <span class="details">
                        <span>{article.author}</span>
                        <time datetime={article.publishedAt}>
                          {formatDate(article.publishedAt)}
                        </time>
                      </span>
                    </a>
                  </div>
                )}
              </For>
            </div>
            <Show when={truncated()}>
              <p class="empty-pane">
                This preview shows part of the feed. Subscribing imports all of
                it.
              </p>
            </Show>
          </div>
        </section>
      </Show>
      <article
        aria-label="Preview reader"
        class={[
          "dashboard-pane reader-pane",
          { "focused-pane": props.pane() === "reader" },
        ]}
      >
        <div class="toolbar">
          <BackButton backPane={props.backPane} />
          <span />
        </div>
        <div class="reader">
          <Show
            when={selectedArticle()}
            fallback={
              <p class="empty-pane">
                {articles().length
                  ? "Select a preview article."
                  : props.editing
                    ? "This feed's articles are in its list on the dashboard."
                    : "Load a preview to read its articles here."}
              </p>
            }
          >
            {(item) => (
              <>
                <ReaderHeader
                  author={item().author}
                  feed={title() || undefined}
                  publishedAt={item().publishedAt}
                  title={item().title}
                  url={item().url || undefined}
                />
                <Enclosures article={item()} body={item().content} />
                <ArticleMarkup html={item().content} />
              </>
            )}
          </Show>
        </div>
      </article>
    </>
  );
}
