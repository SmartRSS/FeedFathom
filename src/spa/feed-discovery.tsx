import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  foldersResponse,
  foundFeedsResponse,
  previewResponse,
  sessionResponse,
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
import { readerHidden, type DashboardPane } from "./panes.ts";
import { Enclosures } from "./enclosures.tsx";
import { api, ApiError, failureDetails, messageOf } from "./api.ts";
import { ArticleMarkup } from "./article-markup.tsx";
import { createAdminFlag, FailureDetails } from "./failure-details.tsx";
import { websiteValidationMessage, withScheme } from "./discovery-behavior.ts";
import {
  isNewsletterAddress,
  newsletterAddress,
} from "#shared/util/newsletter-address.ts";
import { formatDate } from "./format-date.ts";
import { ReaderHeader } from "./reader-header.tsx";
import { BackButton } from "./page-toolbar.tsx";

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
  // A folder to start in (its uid), for Discover opened from that folder.
  initialFolder?: string | undefined;
  initialNewsletter?: boolean;
  pane(): DashboardPane;
  saved(sourceId: number): void;
}) {
  const [link, setLink] = createSignal("");
  const [feedUrl, setFeedUrl] = createSignal("");
  const isEmail = () => isEmailAddress(feedUrl());
  const [title, setTitle] = createSignal("");
  const [folderId, setFolderId] = createSignal("");
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [feeds, setFeeds] = createSignal<FoundFeed[]>([]);
  const [articles, setArticles] = createSignal<PreviewArticle[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal<number>();
  const [loading, setLoading] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [message, setMessage] = createSignal("");
  // A failed preview belongs to the Feed URL field, not the page: it shows
  // under that field and clears once the address changes.
  const [previewError, setPreviewError] = createSignal("");
  const [previewDetails, setPreviewDetails] =
    createSignal<ReturnType<typeof failureDetails>>();
  const isAdmin = createAdminFlag();
  const [startupMessage, setStartupMessage] = createSignal("");
  // Only set where the server ingests mail, which is what gates the
  // newsletter button below -- a minted address is useless otherwise.
  const [mailDomain, setMailDomain] = createSignal("");
  const reportError = (cause: unknown, fallback: string) => {
    if (props.handleUnauthorized(cause)) return;
    setMessage(messageOf(cause, fallback));
  };
  const selectedArticle = () => {
    const index = selectedIndex();
    return index === undefined ? undefined : articles()[index];
  };
  // Finding and previewing share one controller: starting either abandons
  // whichever is still in flight.
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

  onMount(() => {
    // The pane that held focus (the toolbar button that opened this) was
    // just unmounted, which drops focus to <body>: start in the form, on the
    // first field that can be typed into (Title when editing).
    form
      .querySelector<HTMLInputElement>("input:not([disabled], [readonly])")
      ?.focus();
    if (props.editing) {
      setFeedUrl(props.editing.xmlUrl);
      setLink(props.editing.homeUrl);
      setTitle(props.editing.name);
    } else {
      const initialFeedUrl = props.initialFeedUrl;
      if (initialFeedUrl) {
        setFeedUrl(initialFeedUrl);
        if (isWebUrl(initialFeedUrl)) void preview(initialFeedUrl);
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
        // so it would silently fall back to "No folder" instead.
        setFolderId(
          (props.editing ? props.editing.parentUid : props.initialFolder) ?? "",
        );
      } catch (cause) {
        if (disposed || props.handleUnauthorized(cause)) return;
        setStartupMessage(messageOf(cause, "Could not load your folders."));
      }
    })();
    // Separate from the folders load: mail being unavailable only costs the
    // newsletter button, so a failure here must not take the panel's own
    // startup message with it.
    if (!props.editing)
      void (async () => {
        try {
          const session = await api("/session", sessionResponse);
          if (disposed) return;
          const domain = session.mailDomain;
          setMailDomain(domain ?? "");
          if (!domain) return;
          if (props.initialNewsletter && !feedUrl())
            void mintNewsletterAddress(domain).then(reportUnreserved);
          // A reload of a minted address: reserving is idempotent, and this
          // recovers one whose first reservation failed.
          else if (isNewsletterAddress(feedUrl(), domain))
            void reserveNewsletterAddress(feedUrl()).then(reportUnreserved);
        } catch {}
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
      // Beside a visible reader a preview lands on its first article. Where
      // the reader is out of sight until a row is opened, nothing is
      // selected yet, as in the dashboard's list.
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
      // On one pane at a time the form, where the error is, comes forward.
      props.focusPane("sources");
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setProgress("");
      }
    }
  }

  function selectPreviewArticle(index: number, event: MouseEvent) {
    // A modified click is the browser's gesture for "open this elsewhere",
    // so the pane must not swallow it by selecting instead.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    setSelectedIndex(index);
    props.focusPane("reader");
  }

  // The address goes into the URL as ?feedUrl= (the form old extensions
  // opened), so a reload or a discarded tab coming back shows the address the
  // user already copied instead of minting a new one.
  function mintNewsletterAddress(domain: string) {
    const address = newsletterAddress(domain);
    setFeedUrl(address);
    if (location.pathname === "/preview")
      history.replaceState(
        history.state,
        "",
        `/preview?feedUrl=${encodeURIComponent(address)}`,
      );
    return reserveNewsletterAddress(address);
  }

  // The address is in the user's hands from now on, and mail sent to it
  // before its source exists bounces for good, which can end the newsletter
  // subscription before it starts (#1116). So the source is created now,
  // not on Subscribe. False when that failed and nothing has reported it.
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

  // Subscribe still creates the source, so the address is not lost, only
  // its mail until then.
  function reportUnreserved(reserved: boolean) {
    if (!reserved)
      setMessage(
        "Address not reserved: mail sent to it bounces until you subscribe. Generate another or subscribe now.",
      );
  }

  async function useNewsletterAddress() {
    const reserved = mintNewsletterAddress(mailDomain());
    setArticles([]);
    setSelectedIndex(undefined);
    await copyAddress();
    // After the copy's own message, which would otherwise hide this one.
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
      // The server's answer to a malformed target and to an address this
      // account may not subscribe to, alike (addresses are minted only).
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
        class="dashboard-pane sources-pane"
        classList={{
          "discovery-wide": !articles().length,
          "focused-pane": props.pane() === "sources",
        }}
      >
        {/* A toolbar like the other panes', so the three top edges line up;
            its title is the pane's heading. */}
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
            {/* Same shared-row lock as Feed URL below when editing -- see
                that field's comment. */}
            <input
              ref={websiteInput}
              readOnly={!!props.editing}
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
            {/* An address generated for email subscriptions is not a URL,
                and the field says what it holds. */}
            {isEmail() ? "Email address" : "Feed URL"}
            {/* Shared/deduplicated across every subscriber to this feed
                (see sources_url_unique) -- locked here so editing can't
                silently repoint everyone else's subscription too.
                Unsubscribing and subscribing to a different URL is the
                supported way to point at a different feed. */}
            <input
              aria-describedby={previewError() ? "feed-url-error" : undefined}
              aria-invalid={previewError() ? "true" : undefined}
              readOnly={!!props.editing}
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
            {(details) => <FailureDetails admin={isAdmin()} {...details()} />}
          </Show>
          {/* The address's own next step, right under it: primary until the
              title is in, which a preview fills and Subscribe then needs, so
              one primary action shows at a time. */}
          <Show when={!props.editing && !isEmail()}>
            <button
              class="field-action"
              classList={{ "button-primary": Boolean(feedUrl()) && !title() }}
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
          {/* Subscribing by email is another way in, not a step of the
              address above, so it is its own group after the fields. */}
          <Show when={!props.editing && (mailDomain() || isEmail())}>
            <fieldset class="discovery-email">
              <legend>Subscribe by email</legend>
              <div class="discovery-email-actions">
                <Show when={mailDomain()}>
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
      {/* The preview list exists only while there is something to list;
          until then the form takes its column too (style.css). */}
      <Show when={articles().length}>
        <section
          aria-label="Preview articles"
          class="dashboard-pane articles-pane"
          classList={{ "focused-pane": props.pane() === "articles" }}
        >
          <div class="toolbar">
            <BackButton backPane={props.backPane} />
            <strong>{title() || "Preview"}</strong>
            <span />
          </div>
          <div class="article-list">
            {/* The list covers only the rows: the truncation note beside it
                is not a listitem, and a list may only own listitems. */}
            <div role="list">
              <For each={articles()}>
                {(article, index) => (
                  <div role="listitem">
                    <a
                      aria-current={
                        selectedIndex() === index() ? "true" : undefined
                      }
                      class="article"
                      classList={{ selected: selectedIndex() === index() }}
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
