import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  articlePageSize,
  articleResponse,
  articlesResponse,
  folderResponse,
  removedArticlesResponse,
  removedIdResponse,
  snoozedSourceResponse,
  treeResponse,
  updatedFolderResponse,
  type Article,
  type ArticleSummary,
  type TreeNode,
} from "#shared/contracts/responses.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";
import {
  faviconUrls,
  filterTree,
  findNode,
  findParentFolderUid,
  isSnoozedNode,
  isTodayNode,
  nextPollDelayMs,
  sourceIds,
  snoozePresets,
  snoozeUntilIso,
  totalUnread,
  treeNodeKey,
  treeTabStopKey,
  withDecrementedUnread,
  withTodayNode,
} from "./dashboard-behavior.ts";
import {
  createThrottledRecorder,
  ratioToScrollTop,
  ReadingSessionStore,
  scrollRatio,
} from "./reading-session.ts";
import {
  removalOutcome,
  soleSelectedIndex,
  transitionArticleSelection,
  type DashboardPane,
} from "./behavior.ts";
import { createSupersessionGuard } from "./supersession.ts";
import { api } from "./api.ts";
import {
  createExtensionReaderBridge,
  extractReaderContent,
  ReaderExtensionError,
  type ReaderContent,
  type ReaderMode,
} from "./extension-reader.ts";
import { BackButton, FeedDiscovery } from "./feed-discovery.tsx";
import { Icon } from "./icon.tsx";
import { TreeItem } from "./tree-item.tsx";
import {
  markReadPolicy,
  rememberReadingPosition,
  resolvedTheme,
  todayView,
} from "./preferences.ts";
import { ScrollPastQueue } from "./scroll-past.ts";
import { formatDate } from "./format-date.ts";
import { ContextMenu, type ContextMenuItem } from "./context-menu.tsx";
import { shareArticle } from "./share-article.ts";
import { confirmDialog, helpDialog, promptDialog } from "./dialog.tsx";
import { isTextEntry, mapArticleShortcut } from "./keyboard-shortcuts.ts";
import {
  navigatorConnection,
  prefetchNextEnabled,
  shouldPrefetch,
} from "./reading-prefetch.ts";
import {
  backgroundPollEnabled,
  newArticlesCount,
  setNewArticlesCount,
  setUnreadTotal,
} from "./news-signal.ts";
// Raw markup, not <img src>: every icon is fill/stroke="currentColor", which
// only resolves against the row's text color when the SVG is in the page's
// DOM. As an external image it would need per-case light/dark guessing.
import addFolderRaw from "./assets/icons/Document/folder-add-fill.svg?raw";
import addRaw from "./assets/icons/System/add-box-fill.svg?raw";
import settingsRaw from "./assets/icons/System/settings-5-fill.svg?raw";
import detailsRaw from "./assets/icons/System/information-fill.svg?raw";
import removeRaw from "./assets/icons/System/delete-bin-7-fill.svg?raw";
import refreshRaw from "./assets/icons/System/refresh-fill.svg?raw";
import shareRaw from "./assets/icons/System/share-fill.svg?raw";
import selectAllRaw from "./assets/icons/System/check-double-fill.svg?raw";
import checkCircleRaw from "./assets/icons/System/check-circle-fill.svg?raw";
import dotCircleRaw from "./assets/icons/System/dot-circle-fill.svg?raw";

function ReaderBody(props: { content: ReaderContent }) {
  return props.content.kind === "html" ? (
    <div innerHTML={props.content.content} />
  ) : (
    <div class="reader-plain">{props.content.content}</div>
  );
}

// First tree render only (see onMount): holds the skeleton until every
// favicon settles. A failure resolves via the .catch() below, so a broken
// favicon can't hang it -- only one that never settles, which the browser's
// network timeout bounds.
function preloadFavicons(tree: TreeNode[]): Promise<void> {
  const urls = tree.flatMap(faviconUrls);
  if (!urls.length) return Promise.resolve();
  return Promise.all(
    urls.map((url) => {
      const image = new Image();
      image.src = url;
      return image.decode().catch(() => {});
    }),
  ).then(() => {});
}

const READER_SKELETON_PARAGRAPHS = [
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod",
  "Tempor incididunt ut labore et dolore magna aliqua ut enim ad minim",
  "Veniam quis nostrud exercitation ullamco laboris nisi ut aliquip",
  "Ex ea commodo consequat duis aute irure dolor",
  "In reprehenderit in voluptate velit esse cillum dolore eu fugiat",
  "Nulla pariatur excepteur sint occaecat",
];
const TREE_SKELETON_NAMES = [
  "Example Feed Name",
  "A Longer Podcast Title",
  "Short Blog",
  "Weekly Newsletter Digest",
];
const ARTICLE_SKELETON_TITLES = [
  "An Example Article Headline Goes Here",
  "Shorter Headline",
  "A Somewhat Longer Article Title About Something",
  "Another Example Headline",
];

export function Dashboard(props: {
  backPane(): void;
  focusPane(next: DashboardPane): void;
  handleUnauthorized(cause: unknown): boolean;
  initialDiscovery?: boolean;
  initialFeedUrl?: string | undefined;
  navigate(to: string): void;
  pane(): DashboardPane;
}) {
  const [tree, setTree] = createSignal<TreeNode[]>([]);
  const [treeFilter, setTreeFilter] = createSignal("");
  // Unread is what the list has always shown; the other two are new views
  // over the same store rather than a change to the default.
  const [articleFilter, setArticleFilter] = createSignal<
    "all" | "read" | "unread"
  >("unread");
  const visibleTree = () =>
    filterTree(withTodayNode(tree(), todayView() === "on"), treeFilter());
  const [treeLoading, setTreeLoading] = createSignal(true);
  const [articles, setArticles] = createSignal<ArticleSummary[]>([]);
  const [articlesLoading, setArticlesLoading] = createSignal(false);
  // The server caps a page at articlePageSize, so a full page means there is
  // at least one more to fetch. Not signals: nothing renders them.
  //
  // The cursor is the last row of the last page received, not the last row
  // still on screen. Deleting rows must not move it: deleting the whole page
  // would leave no row to take a cursor from at all, which is exactly when
  // the next page is most wanted.
  let moreArticles = false;
  let loadingMoreArticles = false;
  let articleCursor: number | undefined;
  const [selectedIndexes, setSelectedIndexes] = createSignal(new Set<number>());
  const [focusedIndex, setFocusedIndex] = createSignal(0);
  const [selectionAnchor, setSelectionAnchor] = createSignal<number>();
  const [openedArticle, setOpenedArticle] = createSignal<Article>();
  const [readerContent, setReaderContent] = createSignal<ReaderContent>();
  const [loadingArticle, setLoadingArticle] = createSignal(false);
  const selected = () => {
    const index = soleSelectedIndex(selectedIndexes());
    return index === undefined ? undefined : articles()[index];
  };
  const [selectedNode, setSelectedNode] = createSignal<TreeNode>();
  const [editingSource, setEditingSource] =
    createSignal<Extract<TreeNode, { type: "source" }>>();
  // Roving tabindex for the tree: only the last-focused row is a Tab stop,
  // so Tab moves in and out of the whole tree instead of through every row.
  const [focusedTreeKey, setFocusedTreeKey] = createSignal<string>();
  const treeTabStop = () => treeTabStopKey(visibleTree(), focusedTreeKey());
  // A screen reader can't be detected, so this always renders (see the
  // aria-live region below); it is visually hidden either way and only gets
  // real text when high contrast mode is off.
  const [accessibilityAnnouncement, setAccessibilityAnnouncement] =
    createSignal("");
  const [contextMenu, setContextMenu] = createSignal<
    { items: ContextMenuItem[]; x: number; y: number } | undefined
  >();
  const [displayMode, setDisplayMode] = createSignal<"FEED" | ReaderMode>(
    "FEED",
  );
  const [readerAvailable, setReaderAvailable] = createSignal(false);
  const [error, setError] = createSignal("");
  const reportError = (cause: unknown, fallback: string) => {
    if (props.handleUnauthorized(cause)) return;
    setError(cause instanceof Error ? cause.message : fallback);
  };
  const [showDiscovery, setShowDiscovery] = createSignal(
    props.initialDiscovery ?? false,
  );
  const [authenticated, setAuthenticated] = createSignal(false);
  // Reader documents are extension-only; never proxy them through the FeedFathom backend.
  const readerBridge = createExtensionReaderBridge();
  // Session restoration (#718). `restoring` holds the scroll-past observer
  // (and the reader-scroll recorder) off until the stored positions have been
  // applied, so a restore never looks like the user scrolled past rows. The
  // variable pairs with it to make that observer's very first intersection
  // pass passive: the rows that happen to be visible at the restored position
  // were not scrolled past by anyone, so they are not queued; they become
  // eligible the next time they re-enter the viewport.
  const [restoringSession, setRestoringSession] = createSignal(false);
  let skipObserverFirstPass = false;
  // The article a restored reader pane should resume: applied once its
  // content renders, then dropped.
  let pendingReaderScrollId: number | undefined;
  const readingSession = new ReadingSessionStore({
    local: localStorage,
    session: sessionStorage,
  });
  const recordAppSnapshot = (
    patch: Parameters<ReadingSessionStore["recordApp"]>[0],
  ) => {
    if (!rememberReadingPosition() || restoringSession()) return;
    readingSession.recordApp(patch);
  };
  // Throttled scroll recorders: at most one storage write each per interval.
  const recordListScroll = createThrottledRecorder((top: number) => {
    recordAppSnapshot({ listScrollTop: top });
  });
  const recordReaderScroll = createThrottledRecorder((element: HTMLElement) => {
    const id = openedArticle()?.id;
    if (id === undefined || !rememberReadingPosition() || restoringSession())
      return;
    readingSession.recordReaderScroll(id, scrollRatio(element));
  });
  const displayedArticle = ():
    | { article: Article; content: ReaderContent }
    | undefined => {
    const article = openedArticle();
    if (!article) return undefined;
    if (displayMode() === "FEED")
      return {
        article,
        content: { content: article.content ?? "", kind: "html" },
      };
    const content = readerContent();
    return content ? { article, content } : undefined;
  };
  createEffect(() => {
    if (props.initialDiscovery) setShowDiscovery(true);
  });
  // The tab-title badge reads this (main.tsx); global total by decision.
  // Reset on unmount so a logged-out tab does not keep a stale count.
  createEffect(() => {
    setUnreadTotal(totalUnread(tree()));
  });
  onCleanup(() => {
    clearTimeout(pollTimer);
    setUnreadTotal(0);
    setNewArticlesCount(0);
  });
  // Background new-article poll (#717). The tree already carries every
  // source's unread count, so a rise in the total is the whole signal --
  // and the open article list is never mutated mid-read; the toast asks
  // instead. Spacing backs off from 30s to a 5-minute ceiling and resets
  // when the user refreshes, and hidden tabs skip cycles entirely.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollCycles = 0;
  let lastSeenUnread: number | undefined;
  const schedulePoll = () => {
    // The signal holds "on"/"off" strings and "off" is truthy, so !value
    // never returned here and Off still polled. Compare explicitly.
    if (backgroundPollEnabled() !== "on") return;
    pollTimer = setTimeout(() => {
      if (document.hidden) {
        schedulePoll();
        return;
      }
      void pollForNewArticles();
    }, nextPollDelayMs(pollCycles));
  };
  const pollForNewArticles = async () => {
    try {
      const nextTree = await loadTree();
      const total = totalUnread(nextTree);
      if (lastSeenUnread !== undefined && total > lastSeenUnread) {
        const arrived = total - lastSeenUnread;
        setNewArticlesCount((count) => Math.max(count, arrived));
      }
      lastSeenUnread = total;
    } catch {
      // Background polling stays silent: the next cycle retries, and the
      // ordinary error surfaces already cover the user-visible paths.
    } finally {
      pollCycles += 1;
      schedulePoll();
    }
  };
  async function shareSelected() {
    const article = selected();
    if (!article) return;
    // The share sheet needs no feedback; the clipboard fallback does, and
    // the existing polite live region is exactly that.
    try {
      const outcome = await shareArticle(article);
      if (outcome === "copied")
        setAccessibilityAnnouncement("Article link copied to the clipboard.");
    } catch {
      // The clipboard can be denied or missing (insecure context), and the
      // button must not fail silently the way a rejected void promise does.
      setError("Could not share the article.");
    }
  }
  async function refreshCurrentView() {
    setNewArticlesCount(0);
    pollCycles = 0;
    try {
      const nextTree = await loadTree();
      lastSeenUnread = totalUnread(nextTree);
      const node = selectedNode();
      if (node) await select(node);
    } catch (cause) {
      reportError(cause, "Could not refresh articles");
    }
  }
  const selectionGuard = createSupersessionGuard();
  const articleRequestGuard = createSupersessionGuard();
  const capabilityProbeGuard = createSupersessionGuard();
  const treeRequestGuard = createSupersessionGuard();
  let articleAbortController: AbortController | undefined;
  let treeAbortController: AbortController | undefined;
  let treeRequestPromise: Promise<TreeNode[]> | undefined;
  const disableReader = (message: string) => {
    articleRequestGuard.start();
    setReaderAvailable(false);
    setDisplayMode("FEED");
    setReaderContent(undefined);
    setLoadingArticle(false);
    setError(message);
  };
  const probeReader = async () => {
    const probe = capabilityProbeGuard.start();
    const available = await readerBridge.available();
    if (!capabilityProbeGuard.isCurrent(probe)) return;
    setReaderAvailable(available);
    if (!available && displayMode() !== "FEED")
      disableReader("The Reader extension is unavailable. Showing Feed mode.");
  };
  const focusReaderProbe = () => void probeReader();
  const handleServiceWorkerMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      data &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "queued-mutation-failed"
    ) {
      // The service worker optimistically reported success before the server,
      // once back online, rejected it. Nothing else tells the user.
      setError(
        "A change made while offline could not be applied and was discarded. Reload to see the current state.",
      );
    }
  };
  onCleanup(() => {
    capabilityProbeGuard.start();
    removeEventListener("focus", focusReaderProbe);
    navigator.serviceWorker?.removeEventListener(
      "message",
      handleServiceWorkerMessage,
    );
    readerBridge.dispose();
  });
  async function loadTree(): Promise<TreeNode[]> {
    const request = treeRequestGuard.start();
    treeAbortController?.abort();
    const controller = new AbortController();
    treeAbortController = controller;
    const attempt: Promise<TreeNode[]> = (async () => {
      try {
        return (await api("/tree", treeResponse, { signal: controller.signal }))
          .tree;
      } catch (cause) {
        // "Superseded" only when THIS request's signal caused the failure; a
        // genuine error must still propagate even if another loadTree()
        // started around the same time. Defer to the shared in-flight promise
        // rather than the `tree` signal, because abort() settles before the
        // superseding request's round trip finishes.
        //
        // Check `cause`, not `controller.signal.aborted`: a controller can be
        // aborted after its fetch resolved while a later step (JSON parsing,
        // validation) throws for an unrelated reason, and `aborted` alone
        // would mask that real bug as a silent supersession.
        if (
          cause instanceof DOMException &&
          cause.name === "AbortError" &&
          !treeRequestGuard.isCurrent(request)
        ) {
          return treeRequestPromise ?? Promise.reject(cause);
        }
        throw cause;
      }
    })();
    treeRequestPromise = attempt;
    const nextTree = await attempt;
    if (!treeRequestGuard.isCurrent(request)) return nextTree;
    const current = selectedNode();
    setTree(nextTree);
    if (current) {
      // The virtual Today node is not in the stored tree; keep it selected
      // across refreshes instead of letting findNode drop it.
      setSelectedNode(
        isTodayNode(current)
          ? current
          : findNode(nextTree, current.type, current.uid),
      );
    }
    return nextTree;
  }
  async function addNewFolder() {
    const name = await promptDialog("Folder name");
    if (!name?.trim()) return;
    setError("");
    try {
      await api("/folders", folderResponse, {
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await loadTree();
    } catch (cause) {
      reportError(cause, "Could not create folder");
    }
  }
  onMount(async () => {
    addEventListener("focus", focusReaderProbe);
    navigator.serviceWorker?.addEventListener(
      "message",
      handleServiceWorkerMessage,
    );
    void probeReader();
    // Read the snapshot up front (before any await) so a reload restores the
    // state the tab actually left in, not whatever a faster boot wrote.
    const restored = rememberReadingPosition()
      ? readingSession.snapshot()
      : undefined;
    if (restored) {
      setRestoringSession(true);
      skipObserverFirstPass = true;
    }
    try {
      const nextTree = await loadTree();
      await preloadFavicons(nextTree);
      setAuthenticated(true);
      lastSeenUnread = totalUnread(nextTree);
      if (restored) await restoreFromSnapshot(restored);
      schedulePoll();
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      setRestoringSession(false);
      reportError(cause, "Unable to load feeds.");
    } finally {
      setTreeLoading(false);
      // Focus the tree without select(), which would also load articles.
      queueMicrotask(() =>
        document.querySelector<HTMLElement>(".sources-pane .source")?.focus(),
      );
    }
    // Delayed and set rather than present at mount, so a screen reader treats
    // it as a live-region change instead of part of the first read-through.
    if (resolvedTheme() !== "high-contrast")
      setTimeout(
        () =>
          setAccessibilityAnnouncement(
            "A high-contrast theme is available in accessibility settings.",
          ),
        2000,
      );
  });
  // Session restoration (#718). The snapshot names a tree node; the tree is
  // the source of truth, so a source deleted since the snapshot was written
  // simply isn't found and the whole snapshot is dropped -- the normal boot
  // path proceeds, silently. Re-selecting the node runs the one and only
  // article fetch boot would ever run; no second fetch races it.
  async function restoreFromSnapshot(snapshot: {
    articleFilter: "all" | "read" | "unread";
    articleId: number | undefined;
    listScrollTop: number;
    nodeType: "folder" | "source";
    nodeUid: string;
  }) {
    try {
      const node = findNode(
        withTodayNode(tree(), todayView() === "on"),
        snapshot.nodeType,
        snapshot.nodeUid,
      );
      if (!node) {
        readingSession.clear();
        setRestoringSession(false);
        return;
      }
      setArticleFilter(snapshot.articleFilter);
      await select(node, {
        articleId: snapshot.articleId ?? -1,
        listScrollTop: snapshot.listScrollTop,
      });
    } catch {
      // A restore must never surface as an error; boot continues as usual.
      readingSession.clear();
      setRestoringSession(false);
    }
  }
  // Applies a restored reader ratio once that article's content has
  // rendered. Content height varies (images, Reader extraction), so the
  // stored value is a ratio, resolved against the rendered document.
  createEffect(() => {
    const item = displayedArticle();
    if (!item || item.article.id !== pendingReaderScrollId) return;
    const id = pendingReaderScrollId;
    pendingReaderScrollId = undefined;
    if (!rememberReadingPosition()) return;
    const ratio = readingSession.readerScroll(id);
    if (ratio === undefined) return;
    queueMicrotask(() => {
      const reader = document.querySelector<HTMLElement>(".reader");
      if (!reader) return;
      reader.scrollTop = ratioToScrollTop(
        ratio,
        reader.scrollHeight,
        reader.clientHeight,
      );
    });
  });
  async function select(
    node: TreeNode,
    restore?: { articleId: number; listScrollTop: number },
  ) {
    props.focusPane("articles");
    setSelectedNode(node);
    recordAppSnapshot({
      articleFilter: articleFilter(),
      listScrollTop: 0,
      nodeType: node.type,
      nodeUid: node.uid,
    });
    const selection = selectionGuard.start();
    articleAbortController?.abort();
    if (isTodayNode(node)) {
      await fetchArticlesForBody(
        { sources: [], view: "today" },
        selection,
        restore,
      );
      return;
    }
    const ids = sourceIds(node);
    moreArticles = false;
    articleCursor = undefined;
    if (!ids.length) {
      setArticles([]);
      void setArticleSelection(new Set<number>(), selection);
      setFocusedIndex(0);
      setSelectionAnchor(undefined);
      if (restore) {
        readingSession.clear();
        setRestoringSession(false);
      }
      return;
    }
    await fetchArticlesForBody({ sources: ids }, selection, restore);
  }
  async function fetchArticlesForBody(
    body: { sources: number[]; view?: "today"; cursor?: number },
    selection: ReturnType<typeof selectionGuard.start>,
    // Session restore (#718): re-select the article the snapshot had open
    // rather than always row 0, so the restore is one fetch, not two.
    restore?: { articleId: number; listScrollTop: number },
  ) {
    setArticlesLoading(true);
    const controller = new AbortController();
    articleAbortController = controller;
    try {
      setOpenedArticle(undefined);
      setReaderContent(undefined);
      const nextArticles = await api("/articles", articlesResponse, {
        body: JSON.stringify({ filter: articleFilter(), ...body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!selectionGuard.isCurrent(selection)) return;
      setArticles(nextArticles);
      moreArticles = nextArticles.length === articlePageSize;
      articleCursor = nextArticles.at(-1)?.id;
      // A stale snapshot (article gone, list refilled) degrades to row 0 --
      // the normal boot path -- without any error surface.
      const restoredIndex = restore
        ? nextArticles.findIndex((item) => item.id === restore.articleId)
        : -1;
      const openIndex = restoredIndex >= 0 ? restoredIndex : 0;
      const nextIndexes = new Set(nextArticles.length ? [openIndex] : []);
      void setArticleSelection(nextIndexes, selection);
      setSelectionAnchor(nextArticles.length ? openIndex : undefined);
      queueMicrotask(() => focusArticleAt(openIndex));
      if (restore) {
        recordAppSnapshot({
          articleFilter: articleFilter(),
          articleId: nextArticles[openIndex]?.id,
          listIds: nextArticles.map((item) => item.id),
          listScrollTop: restoredIndex >= 0 ? restore.listScrollTop : 0,
        });
        if (restoredIndex >= 0) {
          pendingReaderScrollId = restore.articleId;
          props.focusPane("reader");
          applyRestoredScroll(restore.listScrollTop);
        } else {
          readingSession.clear();
          setRestoringSession(false);
        }
      } else {
        recordAppSnapshot({
          articleFilter: articleFilter(),
          articleId: nextArticles[openIndex]?.id,
          listIds: nextArticles.map((item) => item.id),
          listScrollTop: 0,
        });
      }
    } catch (cause) {
      if (!selectionGuard.isCurrent(selection)) return;
      reportError(cause, "Could not load articles");
      if (restore) {
        readingSession.clear();
        setRestoringSession(false);
      }
    } finally {
      if (selectionGuard.isCurrent(selection)) setArticlesLoading(false);
    }
  }
  // Scrolls the restored list position in once the rows are on screen. Runs
  // while `restoringSession` is still true, so the scroll-past observer has
  // not been created yet and cannot read the programmatic scroll as reading.
  function applyRestoredScroll(top: number) {
    queueMicrotask(() =>
      requestAnimationFrame(() => {
        const list = document.querySelector<HTMLElement>(".article-list");
        if (list) list.scrollTop = top;
        skipObserverFirstPass = true;
        setRestoringSession(false);
      }),
    );
  }
  // The scroll handler is the only thing that asks for the next page, so a
  // list too short to scroll can never ask. Deleting a whole page is the way
  // in: select all, delete, and the pane is empty with pages still unread and
  // nothing left to scroll. The threshold below reads true for a list that
  // does not overflow (scrollHeight === clientHeight, scrollTop 0), so the
  // same call covers it -- after the render that shortened the list.
  function topUpArticles() {
    queueMicrotask(() => {
      const list = document.querySelector<HTMLElement>(".article-list");
      if (list) void loadMoreArticles(list);
    });
  }
  // Paging is driven by the scroll position rather than a button: the list is
  // the scroll container in both layouts, and on mobile the pane is
  // column-reverse, so a control after the list would render above it.
  async function loadMoreArticles(list: HTMLElement) {
    const cursor = articleCursor;
    const node = selectedNode();
    if (!moreArticles || loadingMoreArticles || cursor === undefined || !node)
      return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > 600) return;
    // Today is scoped by `view`, not by an id list -- its node uid is the
    // string "today", so running it through sourceIds yields [NaN], which
    // serialises to [null] and the request is refused. The next page has to
    // be asked the same way the first one was.
    const today = isTodayNode(node);
    const ids = today ? [] : sourceIds(node);
    if (!today && !ids.length) return;
    const selection = selectionGuard.current();
    loadingMoreArticles = true;
    try {
      const nextArticles = await api("/articles", articlesResponse, {
        body: JSON.stringify({
          cursor,
          filter: articleFilter(),
          sources: ids,
          ...(today ? { view: "today" } : {}),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!selectionGuard.isCurrent(selection)) return;
      moreArticles = nextArticles.length === articlePageSize;
      articleCursor = nextArticles.at(-1)?.id ?? articleCursor;
      if (!nextArticles.length) return;
      setArticles((current) => [...current, ...nextArticles]);
      topUpArticles();
      setAccessibilityAnnouncement(
        `Loaded ${nextArticles.length} more articles.`,
      );
    } catch (cause) {
      if (selectionGuard.isCurrent(selection))
        reportError(cause, "Could not load more articles");
    } finally {
      loadingMoreArticles = false;
    }
  }
  // Changing the filter is a different question about the same selection, so
  // it re-runs select() rather than filtering what is already loaded: only one
  // page is in hand, and the rest of the answer is on the server.
  function changeArticleFilter(next: "all" | "read" | "unread") {
    if (next === articleFilter()) return;
    setArticleFilter(next);
    const node = selectedNode();
    if (node) void select(node);
  }
  // Marking read is the same shape as removing: optimistic locally, the badge
  // reconciled from the tree afterwards. Unlike a removal it is reversible,
  // so a failure resyncs rather than trying to explain itself.
  // What the toolbar button offers: with everything selected already read,
  // the useful action is the reverse one.
  const allSelectedRead = () => {
    const items = articles();
    const chosen = [...selectedIndexes()]
      .map((index) => items[index])
      .filter((article) => article !== undefined);
    return chosen.length > 0 && chosen.every((article) => article.read);
  };
  function setSelectedRead(read: boolean) {
    const items = articles();
    const indexes = [...selectedIndexes()].filter((index) => items[index]);
    const ids = indexes.map((index) => items[index]!.id);
    if (!ids.length) return;
    setError("");
    void markArticlesRead(ids, read);
  }
  async function markArticlesRead(ids: number[], read: boolean) {
    const items = articles();
    const affected = new Set(ids);
    if (articleFilter() === "all") {
      setArticles(
        items.map((article) =>
          affected.has(article.id) ? { ...article, read } : article,
        ),
      );
    } else {
      // In the unread view a read article no longer belongs, and in the read
      // view an unread one does not either, so the row leaves the list the
      // same way a removed one does -- re-asking the server would flash the
      // skeleton over a list that is already correct.
      const indexes = new Set(
        items.flatMap((article, index) =>
          affected.has(article.id) ? [index] : [],
        ),
      );
      const { nextIndex, remaining } = removalOutcome(items, indexes);
      const nextArticle = remaining[nextIndex];
      setArticles(remaining);
      topUpArticles();
      const openNext = setArticleSelection(
        new Set(nextArticle ? [nextIndex] : []),
      );
      openNext?.catch((cause) =>
        reportError(cause, "Could not refresh articles"),
      );
      setSelectionAnchor(nextArticle ? nextIndex : undefined);
      queueMicrotask(() => focusArticleAt(nextArticle ? nextIndex : 0));
    }
    try {
      await api("/articles", removedArticlesResponse, {
        body: JSON.stringify({ articleIdList: ids, read }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      // Marked finished: its half-read position has no future (#718).
      if (read && rememberReadingPosition())
        readingSession.clearReaderScrolls(ids);
      await loadTree();
    } catch (cause) {
      reportError(cause, "Could not update read state");
      const node = selectedNode();
      if (node) void select(node);
    }
  }
  // Scroll-past marking (#714). Only built when the policy asks for it, so
  // every other reader pays nothing: no observer, no timers, no requests.
  // The effect re-runs -- and the previous observer is flushed, disconnected
  // and dropped via onCleanup -- whenever the list changes, because the rows
  // it watches are the ones this render put in the DOM. Batches ride the very
  // same markArticlesRead the `m` key and toolbar button use, so the
  // optimistic removal and selection handling apply identically and no
  // second request shape races them.
  createEffect(() => {
    if (markReadPolicy() !== "on-scroll-past") return;
    // A session restore is mid-flight: it is about to scroll this list to
    // the stored position, and the observer must not be watching yet, or the
    // programmatic scroll would count as the user scrolling past rows (#718).
    // The signal read here re-runs the effect when the restore finishes.
    if (restoringSession()) return;
    const items = articles();
    if (articlesLoading() || !items.length) return;
    const list = document.querySelector<HTMLElement>(".article-list");
    if (!list) return;
    // The rows visible at the moment a restore put the list mid-scroll got
    // there programmatically: the observer's first pass only takes note and
    // queues nothing. They become eligible again once they leave and
    // re-enter the viewport.
    const passiveFirstPass = skipObserverFirstPass;
    skipObserverFirstPass = false;
    const queue = new ScrollPastQueue({
      flush: (ids) => void markArticlesRead(ids, true),
    });
    // Already-read rows and the article the reader pane holds are never
    // queued: re-marking the one being read would pull its row out from under
    // it in the unread view, the same reason on-open stays in "all".
    //
    // The selection, not `openedArticle`, says which row that is. Selecting a
    // row is what opens it, but `openedArticle` only fills in once the fetch
    // for its body lands, and the observer's first pass runs before that --
    // so keying on the fetched article let the row auto-selected on load be
    // queued during the round trip and marked read behind the reader.
    const eligible = (id: number) => {
      const article = items.find((item) => item.id === id);
      return article !== undefined && !article.read && selected()?.id !== id;
    };
    let primed = !passiveFirstPass;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!primed) {
          primed = true;
          for (const entry of entries) {
            const dataset =
              entry.target instanceof HTMLElement
                ? entry.target.dataset
                : undefined;
            const id = items[Number(dataset?.["index"] ?? Number.NaN)]?.id;
            if (id !== undefined) queue.cancel(id);
          }
          return;
        }
        for (const entry of entries) {
          const dataset =
            entry.target instanceof HTMLElement
              ? entry.target.dataset
              : undefined;
          const index = Number(dataset?.["index"] ?? Number.NaN);
          const id = items[index]?.id;
          if (id === undefined) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (eligible(id)) queue.add(id);
            else queue.cancel(id);
          } else {
            queue.cancel(id);
          }
        }
      },
      { root: list, threshold: [0.5] },
    );
    for (const row of list.querySelectorAll<HTMLElement>(
      ".article[data-index]",
    ))
      observer.observe(row);
    onCleanup(() => {
      // A change of list or an unmount must not silently drop rows that had
      // finished dwelling when the policy said they count as read.
      queue.flushNow();
      queue.dispose();
      observer.disconnect();
    });
  });
  async function showProperties() {
    const node = selectedNode();
    if (!node) return;
    if (node.type === "source") {
      setEditingSource(node);
      props.focusPane("sources");
      setShowDiscovery(true);
      return;
    }
    const name = await promptDialog("Folder name", node.name);
    if (!name?.trim() || name === node.name) return;
    setError("");
    try {
      await api("/folders", updatedFolderResponse, {
        body: JSON.stringify({ folderId: Number(node.uid), folderName: name }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      await loadTree();
    } catch (cause) {
      reportError(cause, "Could not rename folder");
    }
  }
  async function copyToClipboard(url: string, announcement: string) {
    try {
      await navigator.clipboard.writeText(url);
      setAccessibilityAnnouncement(announcement);
    } catch {
      setError("Could not access the clipboard.");
    }
  }
  // Per-source snooze (#725). Parsing and saving continue on the server
  // during the pause; this only stores the timestamp and reloads the tree,
  // whose badges and unread list suppress the source until it lapses.
  async function snoozeNode(node: TreeNode, pausedUntil: string | null) {
    if (node.type !== "source" || isTodayNode(node)) return;
    setError("");
    try {
      await api("/source/snooze", snoozedSourceResponse, {
        body: JSON.stringify({
          pausedUntil,
          sourceId: Number(node.uid),
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      await loadTree();
      setAccessibilityAnnouncement(
        pausedUntil === null ? "Feed unsnoozed." : "Feed snoozed.",
      );
    } catch (cause) {
      reportError(
        cause,
        pausedUntil === null
          ? "Could not unsnooze feed"
          : "Could not snooze feed",
      );
    }
  }
  // Right-click / long-press menus (#721). The tree menu selects the row
  // first, so the existing rename/unsubscribe actions -- which operate on
  // selectedNode() -- keep working unchanged, and no re-filing action
  // exists here by design: manual ordering stays a non-feature.
  function openTreeContext(x: number, y: number, node: TreeNode) {
    // The virtual Today row is a view, not a feed: it has no feed URL to
    // copy, no properties to edit, and no subscription to remove, so it
    // opens no menu at all (the tree item still swallows the native menu).
    if (isTodayNode(node)) return;
    setSelectedNode(node);
    const snoozeItems: ContextMenuItem[] =
      node.type === "source"
        ? [
            ...(isSnoozedNode(node)
              ? [
                  {
                    kind: "action",
                    label: "Unsnooze",
                    onSelect: () => void snoozeNode(node, null),
                  } as const,
                ]
              : []),
            ...snoozePresets.map((preset): ContextMenuItem => ({
              kind: "action",
              label: preset.label,
              onSelect: () =>
                void snoozeNode(node, snoozeUntilIso(preset.hours)),
            })),
          ]
        : [];
    const items: ContextMenuItem[] =
      node.type === "folder"
        ? [
            {
              kind: "action",
              label: "Rename folder",
              onSelect: () => void showProperties(),
            },
            {
              disabled: Boolean(node.children?.length),
              kind: "action",
              label: "Delete folder",
              onSelect: () => void removeSelectedNode(),
            },
          ]
        : [
            {
              disabled: !node.homeUrl,
              kind: "action",
              label: "Open original site",
              onSelect: () => window.open(node.homeUrl, "_blank", "noopener"),
            },
            {
              kind: "action",
              label: "Copy feed URL",
              onSelect: () =>
                void copyToClipboard(
                  node.xmlUrl,
                  "Feed URL copied to the clipboard.",
                ),
            },
            {
              kind: "action",
              label: "Edit feed",
              onSelect: () => void showProperties(),
            },
            { kind: "separator" },
            ...snoozeItems,
            { kind: "separator" },
            {
              kind: "action",
              label: "Unsubscribe",
              onSelect: () => void removeSelectedNode(),
            },
          ];
    setContextMenu({ items, x, y });
  }
  async function removeSelectedNode() {
    const node = selectedNode();
    if (!node) return;
    if (node.type === "folder" && node.children?.length) {
      setError("Folder is not empty");
      return;
    }
    if (!(await confirmDialog(`Delete "${node.name}"?`, { danger: true })))
      return;
    try {
      setError("");
      await api(
        node.type === "source" ? "/source" : "/folders",
        removedIdResponse,
        {
          body: JSON.stringify(
            node.type === "source"
              ? { removeSourceId: Number(node.uid) }
              : { removeFolderId: Number(node.uid) },
          ),
          headers: { "Content-Type": "application/json" },
          method: "DELETE",
        },
      );
      setSelectedNode(undefined);
      setArticles([]);
      // The source (and everything under a deleted folder) is gone: no
      // snapshot may point at it, and none of its articles keep a
      // reading position (#718).
      readingSession.clear();
      void setArticleSelection(new Set<number>());
      setFocusedIndex(0);
      setSelectionAnchor(undefined);
      await loadTree();
      // The deleted row's node is gone, dropping focus to document.body.
      queueMicrotask(() =>
        document.querySelector<HTMLElement>(".sources-pane .source")?.focus(),
      );
    } catch (cause) {
      reportError(cause, "Could not delete item");
    }
  }
  // Prefetch the article after the one just opened (#716), so keyboard
  // navigation into it feels instant. One article only, feed mode only --
  // Reader modes fetch through the extension, so there is nothing server-
  // side to warm. The plain GET flows through the service worker's
  // networkFirst handler, so the prefetched copy also replays offline.
  function schedulePrefetch() {
    // Same truthy-"off" trap as the background poll above: compare, don't
    // negate.
    if (prefetchNextEnabled() !== "on") return;
    if (!shouldPrefetch(navigatorConnection())) return;
    const selectedIndex = soleSelectedIndex(selectedIndexes());
    const next =
      selectedIndex === undefined ? undefined : articles()[selectedIndex + 1];
    if (!next) return;
    const run = () => {
      void api(`/article?article=${next.id}`, articleResponse).catch(() => {
        // Best-effort: opening the article fetches it properly anyway.
      });
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run);
    else setTimeout(run, 200);
  }
  async function open(
    article: ArticleSummary,
    selection = selectionGuard.current(),
  ) {
    const request = articleRequestGuard.start();
    const mode = displayMode();
    const isCurrent = () => {
      const selectedIndex = soleSelectedIndex(selectedIndexes());
      return (
        articleRequestGuard.isCurrent(request) &&
        selectionGuard.isCurrent(selection) &&
        mode === displayMode() &&
        selectedIndex !== undefined &&
        articles()[selectedIndex]?.id === article.id
      );
    };
    setOpenedArticle(undefined);
    setReaderContent(undefined);
    setLoadingArticle(true);
    setError("");
    // Whatever restore was waiting to apply belongs to the previous article.
    pendingReaderScrollId = undefined;
    try {
      const opened = await api(
        `/article?article=${article.id}`,
        articleResponse,
      );
      if (!isCurrent()) return;
      setOpenedArticle(opened);
      recordAppSnapshot({ articleId: opened.id });
      // Opt-in, and only in the "all" view. In the unread view marking on
      // open would pull the row out from under the person reading it; there,
      // the toolbar button is the way.
      if (
        markReadPolicy() === "on-open" &&
        !article.read &&
        articleFilter() === "all"
      ) {
        void markArticlesRead([article.id], true);
      }
      if (mode === "FEED") schedulePrefetch();

      if (mode !== "FEED") {
        if (!readerAvailable()) throw new ReaderExtensionError("UNAVAILABLE");
        const fetched = await readerBridge.fetch(opened.url);
        if (!isCurrent()) return;
        const content = await extractReaderContent(
          fetched.html,
          fetched.finalUrl,
          mode,
        );
        if (!isCurrent()) return;
        setReaderContent(content);
      }
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof ReaderExtensionError && cause.unavailable) {
        disableReader(`${cause.message} Showing Feed mode.`);
        return;
      }
      if (mode !== "FEED") {
        setDisplayMode("FEED");
        setReaderContent(undefined);
        setError(
          `${cause instanceof Error ? cause.message : "Could not load Reader content."} Showing Feed mode.`,
        );
        return;
      }
      reportError(cause, "Could not load article");
    } finally {
      if (articleRequestGuard.isCurrent(request)) setLoadingArticle(false);
    }
  }
  function setArticleSelection(
    indexes: Set<number>,
    selection = selectionGuard.current(),
  ): Promise<void> | undefined {
    setSelectedIndexes(indexes);
    setOpenedArticle(undefined);
    setReaderContent(undefined);
    const index = soleSelectedIndex(indexes);
    const article = index === undefined ? undefined : articles()[index];
    if (!article) {
      articleRequestGuard.start();
      setLoadingArticle(false);
      return undefined;
    }
    return open(article, selection);
  }
  function removeSelected() {
    const items = articles();
    const indexes = new Set(
      [...selectedIndexes()].filter((index) => items[index]),
    );
    const ids = [...indexes].map((index) => items[index]!.id);
    if (!ids.length) return;
    setError("");

    // Fired first so network time overlaps the local UI work below.
    const deletion = api("/articles", removedArticlesResponse, {
      body: JSON.stringify({ removedArticleIdList: ids }),
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });

    // Optimistic: removing a batch shouldn't block on a round trip.
    const { nextIndex, remaining } = removalOutcome(items, indexes);
    const nextArticle = remaining[nextIndex];
    setArticles(remaining);
    topUpArticles();
    const openNext = setArticleSelection(
      new Set(nextArticle ? [nextIndex] : []),
    );
    openNext?.catch((cause) =>
      reportError(cause, "Could not refresh articles"),
    );
    const restoreIndex = nextArticle ? nextIndex : 0;
    setSelectionAnchor(nextArticle ? nextIndex : undefined);

    // The server only returns unread articles, so removing one always frees
    // exactly one unread slot. Adjust the count now, reconcile in background.
    const deltas = new Map<string, number>();
    for (const index of indexes) {
      const sourceUid = items[index]!.sourceId.toString();
      deltas.set(sourceUid, (deltas.get(sourceUid) ?? 0) + 1);
    }
    // Reuse the computed tree: Solid 2.0 defers setter visibility to the
    // microtask flush, so a synchronous tree() read sees the pre-decrement one.
    const nextTree = withDecrementedUnread(tree(), deltas);
    setTree(nextTree);
    const current = selectedNode();
    if (current) {
      // Same as loadTree: the virtual Today node is not in the stored tree,
      // so findNode would drop the selection and leave the pane with nothing
      // to page, refresh or re-select against.
      setSelectedNode(
        isTodayNode(current)
          ? current
          : findNode(nextTree, current.type, current.uid),
      );
    }
    // The removed rows' nodes are gone, dropping focus to document.body.
    queueMicrotask(() => focusArticleAt(restoreIndex));

    deletion
      .then(() => {
        // Deleted articles have no reading position to remember (#718).
        if (rememberReadingPosition()) readingSession.clearReaderScrolls(ids);
        return loadTree().catch((cause) =>
          reportError(cause, "Could not refresh tree"),
        );
      })
      .catch((cause) => {
        // Optimistic update already applied; resync rather than hand-revert.
        reportError(cause, "Could not delete articles");
        setArticles(items);
        void setArticleSelection(new Set(indexes));
        setFocusedIndex(Math.min(...indexes));
        setSelectionAnchor(Math.min(...indexes));
        loadTree().catch((reloadCause) =>
          reportError(reloadCause, "Could not refresh tree"),
        );
      });
  }
  // Real DOM focus with the same roving tabindex as the tree, so the browser
  // announces the focused row itself -- no aria-activedescendant plumbing.
  function focusArticleAt(index: number, options?: { scroll?: boolean }) {
    setFocusedIndex(index);
    const element = document.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    );
    element?.focus({ preventScroll: true });
    if (options?.scroll ?? true) element?.scrollIntoView({ block: "nearest" });
  }
  function selectArticle(index: number, event?: MouseEvent | KeyboardEvent) {
    const next = transitionArticleSelection(
      selectedIndexes(),
      index,
      selectionAnchor(),
      event,
    );
    focusArticleAt(index);
    setSelectionAnchor(next.anchor);
    void setArticleSelection(next.indexes);
  }
  // Ctrl/Cmd moves the focus cursor only; Space commits the change. Without
  // the modifier, movement acts like a click and selects just this row.
  function moveTo(index: number, event: KeyboardEvent) {
    if (!articles().length) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) focusArticleAt(index);
    else selectArticle(index, event);
  }
  function moveSelection(offset: number, event: KeyboardEvent) {
    moveTo(
      (focusedIndex() + offset + articles().length) % articles().length,
      event,
    );
  }
  function toggleSelectionAtCursor() {
    const index = focusedIndex();
    const indexes = new Set(selectedIndexes());
    if (indexes.has(index)) indexes.delete(index);
    else indexes.add(index);
    setSelectionAnchor(index);
    void setArticleSelection(indexes);
  }
  // Enter and `v` (#709) share one open-original path: the same safeArticleUrl
  // wrapping and the same window.open options the branch always used, with no
  // mark-as-read side effect -- deleting, not reading, is this reader's flow.
  function openOriginalInNewTab() {
    for (const index of selectedIndexes()) {
      const value = articles()[index]?.url;
      const url = value ? safeArticleUrl(value, window.location.href) : "";
      if (url) window.open(url, "_blank", "noopener");
    }
  }
  function handleArticleKeys(event: KeyboardEvent) {
    if (event.key === "ArrowDown") moveSelection(1, event);
    else if (event.key === "ArrowUp") moveSelection(-1, event);
    else if (event.key === "Home") moveTo(0, event);
    else if (event.key === "End") moveTo(articles().length - 1, event);
    else if (event.key === " ") {
      event.preventDefault();
      toggleSelectionAtCursor();
    } else if (event.key === "Delete") {
      event.preventDefault();
      removeSelected();
    } else if (
      event.key.toLowerCase() === "m" &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // The list is driven from the keyboard -- Delete already is -- so the
      // other thing you can do to a selection should be too.
      event.preventDefault();
      setSelectedRead(!allSelectedRead());
    } else if (
      event.key.toLowerCase() === "a" &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      void setArticleSelection(new Set(articles().map((_, index) => index)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openOriginalInNewTab();
    } else if (event.key === "ArrowLeft") {
      const node = selectedNode();
      if (!node) return;
      event.preventDefault();
      props.focusPane("sources");
      document
        .querySelector<HTMLElement>(`[data-tree-key="${treeNodeKey(node)}"]`)
        ?.focus();
    } else if (
      mapArticleShortcut(event) &&
      !isTextEntry(event.target) &&
      // A showModal() dialog sits on top of the list anyway, so its keys
      // already can't reach here; the check only covers a non-modal edge.
      !document.querySelector("dialog[open]")
    ) {
      // The industry-standard layer (#709), on top of everything above:
      // j/k mirror the arrow keys exactly, v aliases Enter's open-original,
      // r reuses the refresh button's handler, ? opens the cheat sheet.
      const shortcut = mapArticleShortcut(event);
      if (shortcut === "next") moveSelection(1, event);
      else if (shortcut === "previous") moveSelection(-1, event);
      else if (shortcut === "open") {
        event.preventDefault();
        // The reader pane has no separate close affordance -- it always
        // shows whatever the single selection opened -- so "toggle" is the
        // pane toggle: list -> reader, reader -> back to the list row, the
        // same journey ArrowLeft's focus hand-off already takes.
        if (props.pane() === "reader") {
          props.focusPane("articles");
          focusArticleAt(focusedIndex());
        } else {
          props.focusPane("reader");
        }
      } else if (shortcut === "openOriginal") {
        event.preventDefault();
        openOriginalInNewTab();
      } else if (shortcut === "refresh") {
        event.preventDefault();
        void refreshCurrentView();
      } else if (shortcut === "help") {
        event.preventDefault();
        // DialogHost captures the focused row and hands focus back on close.
        void helpDialog();
      }
    }
  }
  return (
    <main class="dashboard">
      <h1 class="sr-only">FeedFathom</h1>
      <div aria-live="polite" class="sr-only" role="status">
        {accessibilityAnnouncement()}
      </div>
      <Show when={contextMenu()}>
        {(menu) => (
          <ContextMenu
            items={menu().items}
            x={menu().x}
            y={menu().y}
            onClose={() => setContextMenu(undefined)}
          />
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <div class="dashboard-alert" role="alert">
            <p>{message()}</p>
            <button type="button" onClick={() => void refreshCurrentView()}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <Show when={newArticlesCount() > 0}>
        <div class="update-banner" role="status">
          <span>
            {newArticlesCount()} new article
            {newArticlesCount() === 1 ? "" : "s"}.
          </span>
          <button type="button" onClick={() => void refreshCurrentView()}>
            Refresh
          </button>
        </div>
      </Show>
      <Show when={!showDiscovery() || !authenticated()}>
        <aside
          aria-label="Feeds"
          class="dashboard-pane sources-pane"
          classList={{ "focused-pane": props.pane() === "sources" }}
        >
          <div class="toolbar">
            <button
              aria-label="add source"
              onClick={() => {
                props.focusPane("sources");
                setShowDiscovery(true);
              }}
            >
              <Icon raw={addRaw} />
            </button>
            <button aria-label="add folder" onClick={() => void addNewFolder()}>
              <Icon raw={addFolderRaw} />
            </button>
            <button
              aria-label="source properties"
              disabled={!selectedNode()}
              onClick={() => void showProperties()}
            >
              <Icon raw={detailsRaw} />
            </button>
            <button
              aria-label="delete source"
              disabled={!selectedNode()}
              onClick={() => void removeSelectedNode()}
            >
              <Icon raw={removeRaw} />
            </button>
            <span />
            <button
              aria-label="options"
              class="only-mobile"
              onClick={() => props.navigate("/options")}
            >
              <Icon raw={settingsRaw} />
            </button>
          </div>
          <Show
            when={!treeLoading()}
            fallback={
              <ul class="tree skeleton" aria-hidden="true">
                <For each={[...Array(50).keys()]}>
                  {(index) => (
                    <li>
                      <div class="source">
                        <span class="node-icon skeleton-row" />
                        <span class="skeleton-text">
                          {
                            TREE_SKELETON_NAMES[
                              index % TREE_SKELETON_NAMES.length
                            ]
                          }
                        </span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            }
          >
            {/* First-run guidance (#723): only ever visible while the tree
                is empty, so it dismisses itself the moment a source exists
                and never needs its own persistence. */}
            <Show
              when={tree().length > 0}
              fallback={
                <div class="tree-empty">
                  <p class="tree-empty-heading">No feeds yet.</p>
                  <button type="button" onClick={() => setShowDiscovery(true)}>
                    Add your first feed
                  </button>
                  <p>
                    Moving from another reader?{" "}
                    <a
                      href="/options#import-opml"
                      onClick={(event) => {
                        event.preventDefault();
                        props.navigate("/options#import-opml");
                      }}
                    >
                      Import an OPML file
                    </a>
                    .
                  </p>
                </div>
              }
            >
              <input
                aria-label="Filter feeds"
                class="tree-filter"
                placeholder="Filter feeds"
                type="search"
                value={treeFilter()}
                onInput={(event) => setTreeFilter(event.currentTarget.value)}
              />
              <Show when={treeFilter().trim() && !visibleTree().length}>
                <p class="tree-empty" role="status">
                  No feeds match that.
                </p>
              </Show>
              <ul
                aria-busy={treeLoading()}
                aria-label="Feeds"
                class="tree"
                role="tree"
              >
                <For each={visibleTree()}>
                  {(node) => (
                    <TreeItem
                      focused={treeTabStop() === treeNodeKey(node)}
                      onContext={openTreeContext}
                      focusedKey={treeTabStop()}
                      node={node}
                      onFocus={(item) => setFocusedTreeKey(treeNodeKey(item))}
                      select={(item) => void select(item)}
                      selected={selectedNode()}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </aside>
        <section
          aria-label="Articles"
          class="dashboard-pane articles-pane"
          classList={{ "focused-pane": props.pane() === "articles" }}
        >
          <div class="toolbar">
            <BackButton backPane={props.backPane} />
            <button
              aria-label="select all"
              onClick={() => {
                // Clicking focuses this button, which sits outside
                // .article-list, so handleArticleKeys would stop firing.
                // Ctrl+A already runs from inside the list; mirror it.
                void setArticleSelection(
                  new Set(articles().map((_, index) => index)),
                );
                if (articles().length) focusArticleAt(0, { scroll: false });
              }}
            >
              <Icon raw={selectAllRaw} />
            </button>
            <button
              aria-label={allSelectedRead() ? "Mark unread" : "Mark read"}
              title={allSelectedRead() ? "Mark unread" : "Mark read"}
              disabled={!selectedIndexes().size}
              onClick={() => setSelectedRead(!allSelectedRead())}
            >
              {/* Circle-check = read, dot-circle = unread: the state the
                  action will produce, so the glyph flips with it (#766).
                  Reader convention, not email's: a check marks read, a dot
                  marks unread, and neither reads as a mail action. */}
              <Icon raw={allSelectedRead() ? dotCircleRaw : checkCircleRaw} />
            </button>
            <button
              aria-label="delete articles"
              disabled={selectedIndexes().size === 0}
              onClick={() => removeSelected()}
            >
              <Icon raw={removeRaw} />
            </button>
            <button
              aria-label="refresh"
              onClick={() => void refreshCurrentView()}
            >
              <Icon raw={refreshRaw} />
            </button>
            <span />
            {/* A visible label, not just an aria-label: among icon buttons a
                bare dropdown reading "Unread" looks like a status, not the
                control that changes which articles the list shows. It is a
                view option, not an action, so it sits right of the spacer
                with the reader pane's display-mode dropdown (#767). */}
            <label class="article-filter-field">
              Show
              <select
                class="article-filter"
                value={articleFilter()}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  if (next === "all" || next === "read" || next === "unread")
                    changeArticleFilter(next);
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
              onClick={() => props.navigate("/options")}
            >
              <Icon raw={settingsRaw} />
            </button>
          </div>
          <div
            aria-busy={articlesLoading()}
            aria-label="Articles"
            aria-multiselectable="true"
            class="article-list"
            role="listbox"
            onKeyDown={handleArticleKeys}
            onScroll={(event) => {
              void loadMoreArticles(event.currentTarget);
              recordListScroll(event.currentTarget.scrollTop);
            }}
          >
            <Show
              when={!articlesLoading()}
              fallback={
                <div class="article-list skeleton" aria-hidden="true">
                  <div class="date-group skeleton-text">Today</div>
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
              <For each={articles()}>
                {(article, index) => (
                  <>
                    <Show
                      when={article.group !== articles()[index() - 1]?.group}
                    >
                      <div aria-hidden="true" class="date-group">
                        {article.group}
                      </div>
                    </Show>
                    <a
                      class="article"
                      classList={{
                        active: focusedIndex() === index(),
                        read: article.read,
                        selected: selectedIndexes().has(index()),
                      }}
                      data-index={index()}
                      href={safeArticleUrl(article.url, window.location.href)}
                      onClick={(event) => {
                        event.preventDefault();
                        selectArticle(index(), event);
                        props.focusPane("reader");
                      }}
                      // Deliberately no contextmenu override. The row is a
                      // real link, so the browser's own menu carries "open in
                      // a background tab" -- the only way to get one on a
                      // phone, where there is no middle click and window.open
                      // always foregrounds -- plus copy link address, save,
                      // search and whatever the reader's own extensions add.
                      // An app menu is prettier and none of that is worth
                      // trading for it. Read state lives on the toolbar.
                      role="option"
                      tabIndex={focusedIndex() === index() ? 0 : -1}
                      aria-selected={selectedIndexes().has(index())}
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
              <Show
                when={
                  !articlesLoading() &&
                  articles().length === 0 &&
                  selectedNode()
                }
              >
                <div class="article-list-empty" role="status">
                  <p>All caught up.</p>
                </div>
              </Show>
              <Show
                when={!articlesLoading() && !selectedNode() && authenticated()}
              >
                <div class="article-list-empty" role="status">
                  <p>Select a feed to read.</p>
                </div>
              </Show>
            </Show>
          </div>
        </section>
        <article
          aria-label="Reader"
          class="dashboard-pane reader-pane"
          classList={{ "focused-pane": props.pane() === "reader" }}
        >
          <div class="toolbar">
            <BackButton backPane={props.backPane} />
            <button
              aria-label="delete article"
              disabled={!selected()}
              onClick={() => removeSelected()}
            >
              <Icon raw={removeRaw} />
            </button>
            <button
              aria-label="share article"
              disabled={!selected()}
              onClick={() => void shareSelected()}
            >
              <Icon raw={shareRaw} />
            </button>
            <span />
            <Show when={readerAvailable()}>
              <select
                aria-label="Article display mode"
                value={displayMode()}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  const mode =
                    value === "READABILITY" ||
                    value === "READABILITY_PLAIN" ||
                    value === "ARTICLE_EXTRACTOR"
                      ? value
                      : "FEED";
                  setDisplayMode(mode);
                  if (selected()) void open(selected()!);
                }}
              >
                <option
                  value="FEED"
                  title="The article as published in the feed"
                >
                  Feed
                </option>
                <option
                  value="READABILITY"
                  title="Cleaned-up reading view of the full article"
                >
                  Reader
                </option>
                <option
                  value="READABILITY_PLAIN"
                  title="Reader view as plain text, no formatting or images"
                >
                  Reader (plain text)
                </option>
                <option
                  value="ARTICLE_EXTRACTOR"
                  title="A different extractor -- try this if Reader strips too much"
                >
                  Reader (fallback)
                </option>
              </select>
            </Show>
            <button
              aria-label="options"
              onClick={() => props.navigate("/options")}
            >
              <Icon raw={settingsRaw} />
            </button>
          </div>
          <div
            class="reader"
            classList={{ skeleton: loadingArticle() && !displayedArticle() }}
            onScroll={(event) => recordReaderScroll(event.currentTarget)}
          >
            <Show
              when={displayedArticle()}
              fallback={
                <Show
                  when={loadingArticle()}
                  fallback={
                    <Show when={selected()}>
                      <p>Reader content unavailable.</p>
                    </Show>
                  }
                >
                  <h1 class="skeleton-text" aria-hidden="true">
                    An Example Article Headline
                  </h1>
                  <For each={READER_SKELETON_PARAGRAPHS}>
                    {(paragraph) => (
                      <p class="skeleton-text" aria-hidden="true">
                        {paragraph}
                      </p>
                    )}
                  </For>
                </Show>
              }
            >
              {(item) => (
                <>
                  <h1>{item().article.title}</h1>
                  <a
                    href={safeArticleUrl(
                      item().article.url,
                      window.location.href,
                    )}
                  >
                    Original
                  </a>
                  <ReaderBody content={item().content} />
                </>
              )}
            </Show>
          </div>
        </article>
      </Show>
      <Show when={showDiscovery() && authenticated()}>
        <FeedDiscovery
          backPane={props.backPane}
          editing={
            editingSource() && {
              homeUrl: editingSource()!.homeUrl,
              name: editingSource()!.name,
              parentUid: findParentFolderUid(tree(), editingSource()!.uid),
              uid: editingSource()!.uid,
              xmlUrl: editingSource()!.xmlUrl,
            }
          }
          focusPane={props.focusPane}
          handleUnauthorized={props.handleUnauthorized}
          initialFeedUrl={props.initialFeedUrl}
          pane={props.pane}
          close={() => {
            const wasEditing = editingSource() !== undefined;
            setShowDiscovery(false);
            setEditingSource(undefined);
            if (props.initialDiscovery) props.navigate("/");
            else
              queueMicrotask(() =>
                document
                  .querySelector<HTMLElement>(
                    wasEditing
                      ? '[aria-label="source properties"]'
                      : '[aria-label="add source"]',
                  )
                  ?.focus(),
              );
          }}
          saved={async (sourceId) => {
            const wasEditing = editingSource() !== undefined;
            setShowDiscovery(false);
            setEditingSource(undefined);
            if (props.initialDiscovery) props.navigate("/");
            const nextTree = await loadTree();
            const nodes = [...nextTree];
            let savedNode: TreeNode | undefined;
            for (const node of nodes) {
              if (node.type === "source" && node.uid === sourceId.toString()) {
                savedNode = node;
                break;
              }
              nodes.push(...(node.type === "folder" ? node.children : []));
            }
            if (!savedNode) return;
            await select(savedNode);
            // Editing renames or moves an existing feed; nothing to fetch, so
            // skip the poll below.
            if (wasEditing) return;
            // Subscribing only queues the fetch (the worker does it), so the
            // list can be empty right after. Poll briefly rather than showing
            // a blank pane; bail if the user navigated away.
            for (
              let attempt = 0;
              attempt < 5 &&
              articles().length === 0 &&
              selectedNode()?.uid === savedNode.uid;
              attempt++
            ) {
              // Sequential on purpose: each attempt rechecks state after its
              // delay, so there is nothing for Promise.all to parallelize.
              // oxlint-disable-next-line no-await-in-loop
              await new Promise((resolve) => setTimeout(resolve, 3000));
              if (selectedNode()?.uid !== savedNode.uid) break;
              // oxlint-disable-next-line no-await-in-loop
              await select(savedNode);
            }
          }}
        />
      </Show>
    </main>
  );
}
