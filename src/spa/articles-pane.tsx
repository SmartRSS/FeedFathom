import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { ArticleSummary } from "#shared/contracts/responses.ts";
import { classifyFetchFailure } from "#shared/util/fetch-failure.ts";
import { emptyListState } from "./article-list.ts";
import { generateBoundaryDates, getDateGroup } from "./date-group.ts";
import { FailingFeedPanel, type RetryState } from "./failure-details.tsx";
import { isEmptyFolder, type ListNode } from "./feed-tree.ts";
import { formatDate, formatDay } from "./format-date.ts";
import { Icon } from "./icon.tsx";
import { BackButton } from "./page-toolbar.tsx";
import { articleSearchBox } from "./preferences.ts";
import { isArticleFilter, type ArticleFilter } from "./reading-session.ts";
import checkCircleRaw from "./assets/icons/System/check-circle-fill.svg?raw";
import dotCircleRaw from "./assets/icons/System/dot-circle-fill.svg?raw";
import refreshRaw from "./assets/icons/System/refresh-fill.svg?raw";
import removeRaw from "./assets/icons/System/delete-bin-7-fill.svg?raw";
import selectAllRaw from "./assets/icons/System/check-double-fill.svg?raw";
import settingsRaw from "./assets/icons/System/settings-5-fill.svg?raw";

const ARTICLE_SKELETON_TITLES = [
  "An Example Article Headline Goes Here",
  "Shorter Headline",
  "A Somewhat Longer Article Title About Something",
  "Another Example Headline",
];

const dayMs = 24 * 60 * 60 * 1000;

export function ArticlesPane(props: {
  admin: boolean;
  allSelectedRead: boolean;
  backPane(): void;
  feedsFailed: boolean;
  // The feeds are still on their way, or failed, with none from before.
  feedsMissing: boolean;
  filter: ArticleFilter;
  focused: boolean;
  isFocused(index: number): boolean;
  isSelected(index: number): boolean;
  listRef(element: HTMLElement): void;
  loading: boolean;
  onAddFeed(): void;
  onDelete(event: Event): void;
  onEditFeed(): void;
  onExitSearch(): void;
  onFilter(filter: ArticleFilter): void;
  onKeyDown(event: KeyboardEvent): void;
  onOptions(): void;
  onRefresh(): void;
  onRetryFeed(): void;
  onRowClick(index: number, event: MouseEvent): void;
  onRowHover(id: number): void;
  onRowLeave(): void;
  onRowPress(event: PointerEvent, id: number): void;
  onRowPressCancel(): void;
  onScroll(list: HTMLElement): void;
  onSearch(): void;
  onSearchTerms(terms: string): void;
  onSelectAll(): void;
  onToggleRead(): void;
  retry: RetryState;
  rows: ArticleSummary[];
  searchTerms: string;
  searching: boolean;
  selected: ListNode | undefined;
  selectedCount: number;
  signedIn: boolean;
  // The list shows its skeleton: loading, or waiting for the feeds with
  // nothing selected yet.
  skeleton: boolean;
}) {
  // Grouped on the reader's own clock and time zone, so "Today" is theirs.
  const groups = createMemo(() => {
    const boundaries = generateBoundaryDates();
    return props.rows.map((row) =>
      getDateGroup(boundaries, new Date(row.publishedAt)),
    );
  });
  const failing = () =>
    props.selected?.type === "source" ? props.selected.failing : undefined;
  const failingCause = () => {
    const state = failing();
    return state ? classifyFetchFailure(state.reason) : undefined;
  };
  const failureDetails = () => {
    const state = failing();
    return state
      ? { reason: state.reason, status: failingCause()?.status }
      : undefined;
  };
  // A failing feed that still has articles lists them, under a notice once
  // it has gone a day without an update: a shorter outage is usually the
  // next poll's to fix. Only on the feed itself, not Today or its folder.
  const failingNotice = () => {
    const state = failing();
    return state?.lastSuccess &&
      props.rows.length > 0 &&
      !props.searching &&
      Date.now() - Date.parse(state.lastSuccess) > dayMs
      ? state.lastSuccess
      : undefined;
  };
  const emptyState = () =>
    emptyListState({
      feedsFailed: props.feedsFailed,
      loading: props.loading,
      rows: props.rows.length,
      searching: props.searching,
      selected: props.selected,
      signedIn: props.signedIn,
    });
  const editFeed = () =>
    failingCause()?.editable ? props.onEditFeed : undefined;
  const feedName = () => props.selected?.name ?? "This feed";
  return (
    <section
      aria-label="Articles"
      class="dashboard-pane articles-pane"
      classList={{ "focused-pane": props.focused }}
    >
      <div class="toolbar">
        <BackButton backPane={props.backPane} />
        <button
          aria-label="select all"
          disabled={props.rows.length === 0}
          onClick={() => props.onSelectAll()}
        >
          <Icon raw={selectAllRaw} />
        </button>
        <button
          aria-label={props.allSelectedRead ? "Mark unread" : "Mark read"}
          title={props.allSelectedRead ? "Mark unread" : "Mark read"}
          disabled={!props.selectedCount}
          onClick={() => props.onToggleRead()}
        >
          {/* Circle-check = read, dot-circle = unread: the state the action
              will produce, so the glyph flips with it (#766). Reader
              convention, not email's: neither reads as a mail action. */}
          <Icon raw={props.allSelectedRead ? dotCircleRaw : checkCircleRaw} />
        </button>
        <button
          aria-label="delete articles"
          disabled={props.selectedCount === 0}
          onClick={(event) => props.onDelete(event)}
        >
          <Icon raw={removeRaw} />
        </button>
        <button aria-label="refresh" onClick={() => props.onRefresh()}>
          <Icon raw={refreshRaw} />
        </button>
        <span />
        {/* A visible label, not just an aria-label: among icon buttons a bare
            dropdown reading "Unread" looks like a status, not the control
            that changes which articles the list shows. It is a view option,
            not an action, so it sits right of the spacer with the reader
            pane's display-mode dropdown (#767). Disabled where no filter
            could list anything; a caught-up feed keeps it, since All is how
            its read articles are reached. */}
        <label class="article-filter-field">
          <span class="article-filter-label">Show</span>
          <select
            class="article-filter"
            disabled={props.feedsMissing || isEmptyFolder(props.selected)}
            value={props.filter}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (isArticleFilter(next)) props.onFilter(next);
            }}
          >
            <option value="unread">Unread</option>
            <option value="all">All</option>
            <option value="read">Read</option>
          </select>
        </label>
        <button
          aria-label="options"
          class="only-mobile"
          onClick={() => props.onOptions()}
        >
          <Icon raw={settingsRaw} />
        </button>
      </div>
      {/* Names the open feed or folder where the list fills the screen and
          the tree is out of sight; hidden beside a visible tree. */}
      <Show when={props.selected}>
        {(node) => <h2 class="pane-title">{node().name}</h2>}
      </Show>
      {/* Its own row rather than a slot in the toolbar, which has no room to
          show what was typed; the tree's filter box sits above the tree for
          the same reason. A form, so Enter submits and the browser gives the
          box its own clear affordance; search runs on submit rather than per
          keystroke, because every query is a full-text scan on someone's
          home server (#697). */}
      <Show when={articleSearchBox.get()}>
        <form
          class="article-search-field"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSearch();
          }}
        >
          {/* Disabled while a selected feed or folder lists nothing and no
              search is open. With nothing selected it stays: search answers
              across every subscription. */}
          <input
            aria-label="Search articles"
            class="article-search"
            disabled={
              props.feedsMissing ||
              (Boolean(props.selected) &&
                !props.loading &&
                !props.rows.length &&
                !props.searching)
            }
            placeholder="Search articles"
            type="search"
            value={props.searchTerms}
            onInput={(event) => {
              props.onSearchTerms(event.currentTarget.value);
              // Emptying the box, by typing back or with the native clear
              // button, leaves search without needing a submit.
              if (!event.currentTarget.value.trim()) props.onExitSearch();
            }}
          />
        </form>
      </Show>
      <Show when={failingNotice()}>
        {(lastSuccess) => (
          <FailingFeedPanel
            admin={props.admin}
            details={failureDetails()}
            layout="notice"
            retry={props.retry}
            onEdit={editFeed()}
            onRetry={props.onRetryFeed}
          >
            <p>
              Not updated since {formatDay(lastSuccess())}.{" "}
              {failingCause()?.sentence}
            </p>
          </FailingFeedPanel>
        )}
      </Show>
      <div
        aria-busy={props.loading}
        aria-label="Articles"
        aria-multiselectable="true"
        class="article-list"
        ref={props.listRef}
        role="listbox"
        onKeyDown={(event) => props.onKeyDown(event)}
        onScroll={(event) => props.onScroll(event.currentTarget)}
      >
        <Show
          when={!props.skeleton}
          fallback={
            <div class="article-list skeleton" aria-hidden="true">
              <div class="date-group" />
              <For each={[...Array(30).keys()]}>
                {(index) => (
                  <div class="article">
                    <span class="title skeleton-text">
                      {
                        ARTICLE_SKELETON_TITLES[
                          index % ARTICLE_SKELETON_TITLES.length
                        ]
                      }
                    </span>
                    <span class="details">
                      <span class="skeleton-text">Jane Doe</span>
                      <time class="skeleton-text">Jan 1, 2026</time>
                    </span>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <For each={props.rows}>
            {(article, index) => (
              <>
                <Show when={groups()[index()] !== groups()[index() - 1]}>
                  <div aria-hidden="true" class="date-group">
                    {groups()[index()]}
                  </div>
                </Show>
                <a
                  class="article"
                  classList={{
                    active: props.isFocused(index()),
                    read: article.read,
                    selected: props.isSelected(index()),
                  }}
                  data-index={index()}
                  href={article.url}
                  // Starts the GET before the click lands; opening awaits
                  // the same request.
                  onPointerDown={(event) => props.onRowPress(event, article.id)}
                  onPointerCancel={() => props.onRowPressCancel()}
                  onPointerEnter={() => props.onRowHover(article.id)}
                  onPointerLeave={() => props.onRowLeave()}
                  onClick={(event) => {
                    event.preventDefault();
                    props.onRowClick(index(), event);
                  }}
                  // No contextmenu override. The row is a real link, so the
                  // browser's own menu carries "open in a background tab",
                  // the only way to get one on a phone, plus copy link
                  // address and whatever the reader's extensions add.
                  role="option"
                  tabIndex={props.isFocused(index()) ? 0 : -1}
                  aria-selected={props.isSelected(index())}
                >
                  <span class="title">{article.title}</span>
                  <span class="details">
                    <span>{article.author}</span>
                    <time datetime={article.publishedAt || undefined}>
                      {formatDate(article.publishedAt)}
                    </time>
                  </span>
                </a>
              </>
            )}
          </For>
        </Show>
      </div>
      {/* Sibling of the listbox, not a child (#933): a listbox may only own
          option/group children. See .article-list-empty in style.css for how
          it keeps the listbox's flex slot. */}
      <Switch>
        <Match when={emptyState() === "noMatches"}>
          <div class="article-list-empty" role="status">
            <p>No articles match that.</p>
          </div>
        </Match>
        <Match when={emptyState() === "failing" && failing()}>
          {(state) => (
            <FailingFeedPanel
              admin={props.admin}
              details={failureDetails()}
              layout="block"
              retry={props.retry}
              role="status"
              onEdit={editFeed()}
              onRetry={props.onRetryFeed}
            >
              <p>
                {state().lastSuccess
                  ? `${feedName()} hasn't updated since ${formatDay(state().lastSuccess)}.`
                  : `${feedName()} isn't updating.`}
              </p>
              <p class="article-list-failing-reason">
                {failingCause()?.sentence}
              </p>
            </FailingFeedPanel>
          )}
        </Match>
        <Match when={emptyState() === "emptyFolder"}>
          <div class="article-list-empty article-list-prompt" role="status">
            <p>This folder is empty. Add a feed or move one here.</p>
            <div class="form-actions">
              <button
                class="button-primary"
                type="button"
                onClick={() => props.onAddFeed()}
              >
                Add feed
              </button>
            </div>
          </div>
        </Match>
        <Match when={emptyState() === "caughtUp"}>
          <div class="article-list-empty" role="status">
            <p>All caught up.</p>
          </div>
        </Match>
        <Match when={emptyState() === "pickFeed"}>
          <div class="article-list-empty" role="status">
            <p>Select a feed to read.</p>
          </div>
        </Match>
        <Match when={emptyState() === "feedsFailed"}>
          <div class="article-list-empty" role="status">
            <p>Nothing to list until the feeds load.</p>
          </div>
        </Match>
      </Switch>
    </section>
  );
}
