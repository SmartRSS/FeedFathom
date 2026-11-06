import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { Static } from "typebox";
import {
  articleResponse,
  articlesResponse,
  folderResponse,
  removedArticlesResponse,
  removedIdResponse,
  sessionResponse,
  snoozedSourceResponse,
  successResponse,
  treeResponse,
  updatedFolderResponse,
  type ArticleSummary,
  type TreeNode,
} from "#shared/contracts/responses.ts";
import {
  articlesRequest,
  createFolderRequest,
  readArticlesRequest,
  refreshSourceRequest,
  removeArticlesRequest,
  removeFolderRequest,
  removeSourceRequest,
  snoozeSourceRequest,
  updateFolderRequest,
} from "#shared/contracts/requests.ts";
import { cachedTreeQuery, cursorPublishedAtHeader } from "./sw-protocol.ts";
import {
  articleScope,
  filterTree,
  findNode,
  findParentFolderUid,
  isEmptyFolder,
  isSnoozedNode,
  readStateDeltas,
  searchScope,
  snoozePresets,
  snoozeUntilIso,
  totalUnread,
  treeNodeKey,
  withDecrementedUnread,
  withTodayNode,
  type ListNode,
  type ListScope,
} from "./feed-tree.ts";
import {
  createThrottledRecorder,
  ratioToScrollTop,
  ReadingSessionStore,
  scrollRatio,
  takeUpdateReload,
  UPDATE_RELOAD_EVENT,
  type AppSnapshot,
} from "./reading-session.ts";
import { restoredSelection, SessionRestore } from "./session-restore.ts";
import {
  removalOutcome,
  soleSelectedIndex,
  transitionArticleSelection,
} from "./article-selection.ts";
import { ArticleList, type ArticleFilter } from "./article-list.ts";
import { readerHidden, type DashboardPane } from "./panes.ts";
import { api, failureDetails, messageOf } from "./api.ts";
import { FailureDetails, type RetryState } from "./failure-details.tsx";
import { deleteTrace } from "./delete-trace.ts";
import { deleteTraceHeader } from "#shared/contracts/headers.ts";
import { createExtensionReaderBridge } from "./extension-reader.ts";
import { ReaderState } from "./reader-content.ts";
import { FeedDiscovery } from "./feed-discovery.tsx";
import {
  articleSearchBox,
  backgroundPoll,
  feedFilterBox,
  markReadPolicy,
  offlineUnread,
  rememberReadingPosition,
  resolvedTheme,
  todayView,
} from "./preferences.ts";
import { observeScrollPast } from "./scroll-past.ts";
import { ContextMenu, type ContextMenuItem } from "./context-menu.tsx";
import { shareArticle } from "./share-article.ts";
import {
  confirmDialog,
  helpDialog,
  isDialogOpen,
  promptDialog,
} from "./dialog.tsx";
import { isTextEntry, mapArticleKey } from "./keyboard-shortcuts.ts";
import { ArticleFetches } from "./reading-prefetch.ts";
import { setUnreadTotal } from "./news-signal.ts";
import { createNewArticleSignal } from "./new-article-signal.ts";
import { createOfflineSync } from "./offline-sync.ts";
import { SourcesPane, type FeedsFailure } from "./sources-pane.tsx";
import { ArticlesPane } from "./articles-pane.tsx";
import { ReaderPane } from "./reader-pane.tsx";

// Only a page the service worker controls asks, since only the worker
// answers ?cached. only-if-cached keeps the request off the network when
// something else does answer it, such as a worker from before #989 that
// forwards it as is: the fetch then reads the HTTP cache or fails.
async function cachedTree(): Promise<TreeNode[] | undefined> {
  if (!navigator.serviceWorker?.controller) return undefined;
  try {
    return (
      await api(`/tree?${cachedTreeQuery}`, treeResponse, {
        cache: "only-if-cached",
        mode: "same-origin",
      })
    ).tree;
  } catch {
    return undefined;
  }
}

const articlesNoun = (count: number) =>
  count === 1 ? "Article" : `${count} articles`;

export function Dashboard(props: {
  backPane(): void;
  focusPane(next: DashboardPane): void;
  handleUnauthorized(cause: unknown): boolean;
  initialDiscovery?: boolean;
  initialFeedUrl?: string | undefined;
  initialNewsletter?: boolean;
  navigate(to: string): void;
  pane(): DashboardPane;
  whenPaneShown(run: () => void): void;
}) {
  // Unmount is final for this instance: work still in flight when it
  // happens must not write the state it leaves behind.
  let disposed = false;
  let sourcesPaneElement: HTMLElement | undefined;
  let addSourceButton: HTMLButtonElement | undefined;
  let propertiesButton: HTMLButtonElement | undefined;
  let articleListElement: HTMLElement | undefined;
  let readerPaneElement: HTMLElement | undefined;
  let readerElement: HTMLElement | undefined;

  // The alert over the panes. Its details, when it has any, explain the
  // message they came with.
  const [problem, setProblem] = createSignal<{
    details?: ReturnType<typeof failureDetails>;
    message: string;
  }>();
  const reportError = (cause: unknown, fallback: string) => {
    if (props.handleUnauthorized(cause)) return;
    setProblem({
      details: failureDetails(cause),
      message: messageOf(cause, fallback),
    });
  };
  const reportMessage = (message: string) => setProblem({ message });
  const clearProblem = () => setProblem(undefined);
  // A screen reader can't be detected, so the polite live region always
  // renders, visually hidden. It speaks only when its text changes, so a
  // second "Article deleted." in a row would be silent: clear it, then set
  // it a task later.
  const [liveText, setLiveText] = createSignal("");
  const announce = (message: string) => {
    setLiveText("");
    setTimeout(() => setLiveText(message), 100);
  };
  // Asked once per dashboard: admins see what lies under a failure, and a
  // mail domain is what lets Discover mint newsletter addresses.
  const [session, setSession] = createSignal<Static<typeof sessionResponse>>();
  api("/session", sessionResponse).then(setSession, () => {});
  const isAdmin = () => session()?.user?.isAdmin ?? false;

  // The feeds.
  const [tree, setTree] = createSignal<TreeNode[]>([]);
  const [treeFilter, setTreeFilter] = createSignal("");
  const [treeLoading, setTreeLoading] = createSignal(true);
  const [treeFailed, setTreeFailed] = createSignal<FeedsFailure>();
  const [authenticated, setAuthenticated] = createSignal(false);
  const [selectedNode, setSelectedNode] = createSignal<ListNode>();
  // A memo, because every tree row reads it and each read walks the tree.
  const visibleTree = createMemo(() =>
    filterTree(withTodayNode(tree(), todayView.get()), treeFilter()),
  );
  // The selection a toolbar can edit or delete: Today is neither.
  const editableNode = () => {
    const node = selectedNode();
    return node?.type === "view" ? undefined : node;
  };
  // The feed list failed to load, or has not yet, and there is none from
  // before: nothing to filter or search.
  const feedsUnavailable = () => Boolean(treeFailed()) && !tree().length;
  const feedsPending = () => treeLoading() && !tree().length;
  const feedName = (article: { sourceId: number }) =>
    findNode(tree(), "source", String(article.sourceId))?.name;

  // The list: a node's articles, or search results (#697). Search is a mode
  // over the list rather than a filter of what is loaded: the terms go to the
  // server, which answers across every subscription and pages by the same
  // keyset cursor. `searchTerms` is what is typed, `activeSearch` what the
  // server was last asked; selecting a feed clears both.
  const [searchTerms, setSearchTerms] = createSignal("");
  const [activeSearch, setActiveSearch] = createSignal("");
  const [articleFilter, setArticleFilter] =
    createSignal<ArticleFilter>("unread");
  const list = new ArticleList((scope, cursor, signal) =>
    api("/articles", articlesResponse, {
      headers:
        cursor && offlineUnread.get()
          ? { [cursorPublishedAtHeader]: cursor.publishedAt }
          : {},
      json: {
        filter: articleFilter(),
        ...scope,
        ...(cursor ? { cursor: cursor.id } : {}),
      },
      method: "POST",
      request: articlesRequest,
      signal,
    }),
  );
  // Hiding a box must not leave what it held in force: an invisible filter
  // still narrowing the tree, or search results with nothing on screen to
  // explain or undo them.
  createEffect(() => {
    if (!feedFilterBox.get() && treeFilter()) setTreeFilter("");
  });
  createEffect(() => {
    if (!articleSearchBox.get()) {
      setSearchTerms("");
      void exitSearch();
    }
  });

  // The selection within the list. Selectors notify only the rows whose
  // state flips, not every row of a list infinite scroll grows without bound.
  const [selectedIndexes, setSelectedIndexes] = createSignal(new Set<number>());
  const [focusedIndex, setFocusedIndex] = createSignal(0);
  const [selectionAnchor, setSelectionAnchor] = createSignal<number>();
  const isFocused = createSelector(focusedIndex);
  const isSelected = createSelector(selectedIndexes, (index: number, indexes) =>
    indexes.has(index),
  );
  const selected = () => {
    const index = soleSelectedIndex(selectedIndexes());
    return index === undefined ? undefined : list.rows()[index];
  };

  // The reader.
  const fetches = new ArticleFetches((id, signal) =>
    api(`/article?article=${id}`, articleResponse, { signal }),
  );
  const reader = new ReaderState({
    bridge: createExtensionReaderBridge(),
    clearAlert: clearProblem,
    fetches,
    notice: reportMessage,
    reportError,
  });
  const probeReader = () => void reader.probe();
  addEventListener("focus", probeReader);
  onCleanup(() => {
    removeEventListener("focus", probeReader);
    reader.dispose();
  });

  // Session restoration (#718).
  const restore = new SessionRestore(
    new ReadingSessionStore({
      local: localStorage,
      remember: rememberReadingPosition.get,
      resumingUpdate: takeUpdateReload(),
      session: sessionStorage,
    }),
  );
  // Rows are named by id: an index means nothing once the list is refetched.
  const listState = () => {
    const rows = list.rows();
    const idAt = (index: number | undefined) =>
      index === undefined ? undefined : rows[index]?.id;
    return {
      anchorId: idAt(selectionAnchor()),
      focusedId: idAt(focusedIndex()),
      loadedCount: rows.length,
      search: activeSearch() || undefined,
      selectedIds: [...selectedIndexes()].flatMap((index) => idAt(index) ?? []),
    };
  };
  // Nothing to record before a list exists; recording then would overwrite
  // the snapshot boot is about to restore.
  createEffect(() => {
    const state = listState();
    if (selectedNode() || state.search) restore.record(state);
  });
  const recordListScroll = createThrottledRecorder((top: number) =>
    restore.record({ listScrollTop: top }),
  );
  const recordReaderScroll = createThrottledRecorder((element: HTMLElement) => {
    const id = reader.opened()?.id;
    if (id !== undefined && !restore.restoring())
      restore.store.recordReaderScroll(id, scrollRatio(element));
  });
  const saveForUpdateReload = () => {
    const node = selectedNode();
    if (!node && !activeSearch()) return;
    const articleId = reader.opened()?.id;
    restore.store.saveBeforeReload(
      {
        ...listState(),
        articleFilter: articleFilter(),
        articleId,
        listScrollTop: articleListElement?.scrollTop ?? 0,
        nodeType: node?.type ?? "source",
        nodeUid: node?.uid ?? "",
      },
      articleId !== undefined && readerElement
        ? { id: articleId, ratio: scrollRatio(readerElement) }
        : undefined,
    );
  };
  addEventListener(UPDATE_RELOAD_EVENT, saveForUpdateReload);
  onCleanup(() =>
    removeEventListener(UPDATE_RELOAD_EVENT, saveForUpdateReload),
  );
  // A restored reader resumes its ratio once that article has rendered.
  // Content height varies (images, Reader extraction), so the stored value
  // is a ratio, resolved against the rendered document.
  createEffect(() => {
    const item = reader.displayed();
    if (!item) return;
    const ratio = restore.takeReaderScroll(item.article.id);
    if (ratio === undefined) return;
    // A hidden reader measures zero, which would resolve any ratio to the top.
    queueMicrotask(() =>
      props.whenPaneShown(() => {
        if (!readerElement) return;
        readerElement.scrollTop = ratioToScrollTop(
          ratio,
          readerElement.scrollHeight,
          readerElement.clientHeight,
        );
      }),
    );
  });

  // The tab-title badge reads the total (main.tsx); it is reset on unmount
  // so a logged-out tab does not keep a stale count.
  createEffect(() => setUnreadTotal(totalUnread(tree())));
  let treeAbortController: AbortController | undefined;
  let treeRequestPromise: Promise<TreeNode[]> | undefined;
  onCleanup(() => {
    disposed = true;
    treeAbortController?.abort();
    setUnreadTotal(0);
  });
  const newArticles = createNewArticleSignal({
    enabled: backgroundPoll.get,
    hidden: () => document.hidden,
    listening: () => authenticated() && backgroundPoll.get(),
    loadTree,
    // An expired session goes to sign-in like every other tree load (#1122).
    onPollFailure: (cause) => props.handleUnauthorized(cause),
  });
  createOfflineSync(tree, authenticated);

  // Discover, over the panes.
  const [showDiscovery, setShowDiscovery] = createSignal(
    props.initialDiscovery ?? false,
  );
  createEffect(() => {
    if (props.initialDiscovery) setShowDiscovery(true);
  });
  // The folder Discover starts in when it was opened from an empty folder.
  const [discoveryFolder, setDiscoveryFolder] = createSignal<string>();
  const [editingSource, setEditingSource] =
    createSignal<Extract<TreeNode, { type: "source" }>>();
  const [contextMenu, setContextMenu] = createSignal<
    { items: ContextMenuItem[]; x: number; y: number } | undefined
  >();

  // "Try again" on a failing feed: the fetch runs in the worker, so the tree
  // is reloaded a little later to show how it went.
  const [retryState, setRetryState] = createSignal<RetryState>("idle");
  async function retrySelectedSource() {
    const node = selectedNode();
    if (node?.type !== "source") return;
    setRetryState("sending");
    try {
      await api("/source/refresh", successResponse, {
        json: { sourceId: Number(node.uid) },
        method: "POST",
        request: refreshSourceRequest,
      });
      setRetryState("queued");
      setTimeout(() => {
        setRetryState("idle");
        if (!disposed) void refreshCurrentView();
      }, 8000);
    } catch (cause) {
      setRetryState("idle");
      reportError(cause, "Could not fetch the feed again");
    }
  }

  async function loadTree(): Promise<TreeNode[]> {
    treeAbortController?.abort();
    const controller = new AbortController();
    treeAbortController = controller;
    const attempt: Promise<TreeNode[]> = (async () => {
      try {
        return (await api("/tree", treeResponse, { signal: controller.signal }))
          .tree;
      } catch (cause) {
        // Superseded only when THIS request's signal caused the failure: a
        // genuine error must still propagate even if another loadTree()
        // started around the same time. Check `cause`, not `aborted`: a
        // controller can be aborted after its fetch resolved while a later
        // step (parsing, validation) throws for an unrelated reason. Defer
        // to the shared in-flight promise rather than the `tree` signal,
        // because abort() settles before the replacement's round trip does.
        if (
          cause instanceof DOMException &&
          cause.name === "AbortError" &&
          treeAbortController !== controller
        ) {
          return treeRequestPromise ?? Promise.reject(cause);
        }
        throw cause;
      }
    })();
    treeRequestPromise = attempt;
    const nextTree = await attempt;
    if (controller.signal.aborted) return nextTree;
    setTreeFailed(undefined);
    applyTree(nextTree);
    return nextTree;
  }
  // The selection moves to its node in the new tree. Today is not in the
  // stored tree, so it stays selected.
  function applyTree(nextTree: TreeNode[]) {
    setTree(nextTree);
    const current = selectedNode();
    if (current && current.type !== "view")
      setSelectedNode(findNode(nextTree, current.type, current.uid));
  }
  // Optimistic badge counts; the tree reload after the request reconciles
  // them. Reuses the computed tree: Solid 2.0 defers setter visibility to the
  // microtask flush, so a tree() read right after would see the old one.
  const applyUnreadDeltas = (deltas: Map<string, number>) =>
    applyTree(withDecrementedUnread(tree(), deltas));
  const focusTreeRow = (key?: string) =>
    sourcesPaneElement
      ?.querySelector<HTMLElement>(
        key === undefined ? ".source" : `[data-tree-key="${key}"]`,
      )
      ?.focus();
  const revealTree = () => {
    if (!treeLoading()) return;
    setTreeLoading(false);
    // Focus the tree without select(), which would also load articles. A
    // restored session has already put focus on its row; leave it there.
    queueMicrotask(() => {
      if (document.activeElement && document.activeElement !== document.body)
        return;
      focusTreeRow();
    });
  };

  onMount(async () => {
    void reader.probe();
    // Read up front, before any await, so a reload restores the state the
    // tab actually left in, not whatever a faster boot wrote. A preview
    // route opens on its own form: restoring the last reading session would
    // bring its reader forward over it on one pane.
    const snapshot = restore.store.takeSnapshot();
    const restored = props.initialDiscovery ? undefined : snapshot;
    if (restored) restore.begin();
    try {
      // loadTree replaces this array as it applies the fresh tree, so its
      // identity tells whether the fresh one already landed.
      const unloaded = tree();
      const fresh = loadTree();
      // Stale-while-revalidate (#989): the cached tree paints only if it
      // beats the network, and the fresh one replaces it through loadTree.
      // Everything that trusts the tree (sign-in state, the poll's unread
      // baseline, session restore) still waits for the fresh answer, so a
      // 401 routes to sign-in and the swap never reads as new articles.
      const early = await Promise.race([
        fresh.then(
          () => undefined,
          () => undefined,
        ),
        cachedTree(),
      ]);
      if (early && !disposed && tree() === unloaded) {
        setTree(early);
        revealTree();
      }
      const nextTree = await fresh;
      if (disposed) return;
      setAuthenticated(true);
      // Cancelled by select() if a feed was picked from the cached tree.
      if (restored && restore.restoring()) await restoreFrom(restored);
      newArticles.start(nextTree);
    } catch (cause) {
      if (disposed || props.handleUnauthorized(cause)) return;
      restore.cancel();
      setTreeFailed({
        details: failureDetails(cause),
        message: messageOf(cause, "Could not load your feeds."),
      });
    } finally {
      revealTree();
    }
    // Delayed and set rather than present at mount, so a screen reader treats
    // it as a live-region change instead of part of the first read-through.
    if (resolvedTheme() !== "high-contrast")
      setTimeout(
        () =>
          announce(
            "A high-contrast theme is available in accessibility settings.",
          ),
        2000,
      );
  });

  // The snapshot names a tree node, and the tree is the source of truth: a
  // source deleted since then isn't found, the snapshot is dropped and the
  // normal boot path proceeds. Re-selecting the node runs the one article
  // fetch boot would ever run.
  async function restoreFrom(snapshot: AppSnapshot) {
    const node = findNode(
      withTodayNode(tree(), todayView.get()),
      snapshot.nodeType,
      snapshot.nodeUid,
    );
    const search = articleSearchBox.get() ? snapshot.search : undefined;
    if (!node && !search) {
      restore.abandon();
      return;
    }
    setArticleFilter(snapshot.articleFilter);
    if (search) {
      if (node) setSelectedNode(node);
      setSearchTerms(search);
      await runSearch(search, snapshot);
    } else if (node) await select(node, snapshot);
  }

  // Selecting one row opens it in the reader; any other selection closes it.
  function selectRows(indexes: Set<number>) {
    setSelectedIndexes(indexes);
    const index = soleSelectedIndex(indexes);
    const article = index === undefined ? undefined : list.rows()[index];
    if (!article) {
      reader.close();
      return;
    }
    const listSignal = list.signal;
    void reader.open(
      article,
      () => !listSignal.aborted && selected()?.id === article.id,
      (opened) => {
        restore.record({ articleId: opened.id });
        // Opt-in, and only in the "all" view: in the unread view marking on
        // open would pull the row out from under the person reading it.
        if (
          markReadPolicy.get() === "on-open" &&
          !article.read &&
          articleFilter() === "all"
        )
          void markArticlesRead([article.id], true);
        // Reader modes fetch through the extension: nothing server-side to
        // warm.
        if (reader.mode() === "FEED")
          fetches.prefetchAround(
            list.rows(),
            soleSelectedIndex(selectedIndexes()),
            opened.id,
          );
      },
    );
  }
  function emptyList() {
    list.clear();
    selectRows(new Set());
    setFocusedIndex(0);
    setSelectionAnchor(undefined);
  }

  async function showList(scope: ListScope, snapshot?: AppSnapshot) {
    reader.close();
    let rows: ArticleSummary[] | undefined;
    try {
      rows = await list.load(scope, snapshot?.loadedCount);
    } catch (cause) {
      reportError(cause, "Could not load articles");
      if (snapshot) restore.abandon();
      return;
    }
    if (!rows) return;
    const resumed = snapshot && restoredSelection(rows, snapshot);
    if (snapshot && resumed) {
      selectRows(new Set(resumed.indexes));
      setSelectionAnchor(resumed.anchor);
      queueMicrotask(() => focusArticleAt(resumed.focus));
      // A multi-row selection opens no article, so the list keeps focus.
      const opened = selected();
      if (opened) {
        restore.resumeReaderAt(opened.id);
        props.focusPane("reader");
      }
      // Once the rows are on screen. The restore holds the scroll-past
      // observer off until then.
      queueMicrotask(() =>
        requestAnimationFrame(() => {
          if (articleListElement)
            articleListElement.scrollTop = snapshot.listScrollTop;
          restore.finish();
        }),
      );
      return;
    }
    // Beside a visible reader the first row opens at once. Where the reader
    // is out of sight until an article is opened, nothing is selected until
    // the reader asks for something; the keyboard cursor and the selection
    // anchor still start on the first row.
    const opensFirst = rows.length > 0 && !readerHidden();
    selectRows(new Set(opensFirst ? [0] : []));
    setSelectionAnchor(rows.length ? 0 : undefined);
    queueMicrotask(() => focusArticleAt(0));
    restore.record({
      articleFilter: articleFilter(),
      articleId: opensFirst ? rows[0]?.id : undefined,
      listScrollTop: 0,
    });
    // A stale snapshot, whose rows are gone, degrades to the normal path.
    if (snapshot) restore.abandon();
  }

  async function select(node: ListNode, snapshot?: AppSnapshot) {
    if (!snapshot) restore.cancel();
    props.focusPane("articles");
    // Picking a feed answers a different question than the search did, so
    // the box empties with the list.
    setSearchTerms("");
    setActiveSearch("");
    setSelectedNode(node);
    restore.record({
      articleFilter: articleFilter(),
      listScrollTop: 0,
      nodeType: node.type,
      nodeUid: node.uid,
    });
    if (isEmptyFolder(node)) {
      emptyList();
      if (snapshot) restore.abandon();
      return;
    }
    await showList(articleScope(node), snapshot);
  }
  async function runSearch(terms: string, snapshot?: AppSnapshot) {
    const query = terms.trim();
    if (!query) {
      await exitSearch();
      return;
    }
    // Searching for something already read is the ordinary case, and the
    // unread default would answer it with an empty list. Only entering
    // search moves the dropdown: re-running the same terms under a filter
    // the user then chose keeps that choice.
    if (!activeSearch() && !snapshot) setArticleFilter("all");
    setActiveSearch(query);
    props.focusPane("articles");
    clearProblem();
    await showList(searchScope(query), snapshot);
  }
  // Leaving search asks a different question than the request in flight, so
  // it starts over as select() does. Without that, a response that lands
  // after the clear repopulates a list the user just emptied (#815).
  async function exitSearch() {
    if (!activeSearch()) return;
    setActiveSearch("");
    const node = selectedNode();
    if (node) await select(node);
    else list.clear();
  }
  // A different question about the same selection: only one page is in hand,
  // and the rest of the answer is on the server.
  function changeArticleFilter(next: ArticleFilter) {
    if (next === articleFilter()) return;
    setArticleFilter(next);
    const search = activeSearch();
    const node = selectedNode();
    if (search) void runSearch(search);
    else if (node) void select(node);
  }
  async function refreshCurrentView() {
    try {
      await newArticles.refresh();
      const search = activeSearch();
      const node = selectedNode();
      if (search) await runSearch(search);
      else if (node) await select(node);
    } catch (cause) {
      reportError(cause, "Could not refresh articles");
    }
  }

  // Paging is driven by the scroll position rather than a button: the list
  // is the scroll container in both layouts, and on mobile the pane is
  // column-reverse, so a control after the list would render above it.
  async function loadMoreArticles(element: HTMLElement) {
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 600)
      return;
    try {
      const count = await list.loadMore();
      if (!count) return;
      topUpArticles();
      announce(`Loaded ${count} more articles.`);
    } catch (cause) {
      reportError(cause, "Could not load more articles");
    }
  }
  // The scroll handler is the only thing that asks for the next page, so a
  // list too short to scroll could never ask: select all, delete, and the
  // pane is empty with pages still unread. The threshold above reads true
  // for a list that does not overflow, so the same call covers it, after
  // the render that shortened the list.
  function topUpArticles() {
    queueMicrotask(() => {
      if (articleListElement) void loadMoreArticles(articleListElement);
    });
  }

  // Rows leaving the list optimistically. The row that took the first one's
  // place is selected and focused: the removed rows' nodes are gone, which
  // drops focus to document.body.
  function dropRows(indexes: Set<number>) {
    const { nextIndex, remaining } = removalOutcome(list.rows(), indexes);
    const next = remaining[nextIndex] ? nextIndex : undefined;
    list.setRows(remaining);
    topUpArticles();
    selectRows(new Set(next === undefined ? [] : [next]));
    setSelectionAnchor(next);
    queueMicrotask(() => focusArticleAt(next ?? 0));
  }
  // What the toolbar button offers: with everything selected already read,
  // the useful action is the reverse one.
  const allSelectedRead = () => {
    const rows = list.rows();
    const chosen = [...selectedIndexes()].flatMap((index) => rows[index] ?? []);
    return chosen.length > 0 && chosen.every((article) => article.read);
  };
  function setSelectedRead(read: boolean) {
    const rows = list.rows();
    const ids = [...selectedIndexes()].flatMap(
      (index) => rows[index]?.id ?? [],
    );
    if (!ids.length) return;
    clearProblem();
    void markArticlesRead(
      ids,
      read,
      `${articlesNoun(ids.length)} marked ${read ? "read" : "unread"}.`,
    );
  }
  // The shape of a removal, but reversible, so a failure resyncs rather than
  // trying to explain itself. Only the explicit action passes an
  // announcement: on-open and scroll-past marks happen per row as the reader
  // moves, and would chatter.
  async function markArticlesRead(
    ids: number[],
    read: boolean,
    announcement?: string,
  ) {
    const rows = list.rows();
    const affected = new Set(ids);
    applyUnreadDeltas(readStateDeltas(rows, ids, read));
    if (articleFilter() === "all")
      list.setRows(
        rows.map((article) =>
          affected.has(article.id) ? { ...article, read } : article,
        ),
      );
    // In the unread view a read article no longer belongs, and in the read
    // view an unread one does not either; re-asking the server would flash
    // the skeleton over a list that is already correct.
    else
      dropRows(
        new Set(
          rows.flatMap((article, index) =>
            affected.has(article.id) ? [index] : [],
          ),
        ),
      );
    try {
      await api("/articles", removedArticlesResponse, {
        json: { articleIdList: ids, read },
        method: "PATCH",
        request: readArticlesRequest,
      });
      if (announcement) announce(announcement);
      // Marked finished: its half-read position has no future (#718).
      if (read) restore.store.clearReaderScrolls(ids);
      await loadTree();
    } catch (cause) {
      reportError(cause, "Could not update read state");
      const node = selectedNode();
      if (node) void select(node);
    }
  }
  function removeSelected(trigger?: Event) {
    const rows = list.rows();
    const indexes = new Set(
      [...selectedIndexes()].filter((index) => rows[index]),
    );
    const ids = [...indexes].flatMap((index) => rows[index]?.id ?? []);
    if (!ids.length) return;
    clearProblem();
    const listSignal = list.signal;
    // Fired first so network time overlaps the local UI work below.
    const deletion = api("/articles", removedArticlesResponse, {
      headers: { [deleteTraceHeader]: deleteTrace(trigger) },
      json: { removedArticleIdList: ids },
      method: "DELETE",
      request: removeArticlesRequest,
    });
    // Optimistic: removing a batch shouldn't block on a round trip. An
    // unread row takes its count off its source's badge.
    applyUnreadDeltas(readStateDeltas(rows, ids, true));
    dropRows(indexes);
    deletion
      .then(() => {
        announce(`${articlesNoun(ids.length)} deleted.`);
        // Deleted articles have no reading position to remember (#718).
        restore.store.clearReaderScrolls(ids);
        return loadTree().catch((cause) =>
          reportError(cause, "Could not refresh your feeds"),
        );
      })
      .catch((cause) => {
        reportError(cause, "Could not delete articles");
        // The rows go back only into the list they left. A list loaded since
        // already shows what the server holds, and the tree reload below
        // undoes the optimistic unread counts either way.
        if (!listSignal.aborted) {
          list.setRows(rows);
          selectRows(new Set(indexes));
          setFocusedIndex(Math.min(...indexes));
          setSelectionAnchor(Math.min(...indexes));
        }
        loadTree().catch((reloadCause) =>
          reportError(reloadCause, "Could not refresh your feeds"),
        );
      });
  }

  // Mark read on scroll past (#714), built only when the policy asks for it,
  // so every other reader pays nothing. The effect re-runs whenever the list
  // changes, because the rows it watches are the ones this render put in the
  // DOM. Batches ride the same markArticlesRead the `m` key uses.
  createEffect(() => {
    if (markReadPolicy.get() !== "on-scroll-past") return;
    // A restore is about to scroll this list to the stored position, which
    // must not count as the user scrolling past rows (#718). Reading the
    // signal re-runs the effect when the restore finishes.
    if (restore.restoring()) return;
    const rows = list.rows();
    if (list.loading() || !rows.length || !articleListElement) return;
    const stop = observeScrollPast({
      // Already-read rows and the article the reader holds are never queued:
      // re-marking the one being read would pull its row out from under it
      // in the unread view. The selection says which row that is, not the
      // opened article, which fills in only once its body lands, after the
      // observer's first pass.
      eligible: (id) => {
        const article = rows.find((row) => row.id === id);
        return article !== undefined && !article.read && selected()?.id !== id;
      },
      flush: (ids) => void markArticlesRead(ids, true),
      list: articleListElement,
      passiveFirstPass: restore.takePassiveFirstPass(),
      rowId: (row) =>
        row instanceof HTMLElement
          ? rows[Number(row.dataset["index"])]?.id
          : undefined,
    });
    onCleanup(stop);
  });

  // Real DOM focus with the same roving tabindex as the tree, so the browser
  // announces the focused row itself.
  function focusArticleAt(index: number, options?: { scroll?: boolean }) {
    setFocusedIndex(index);
    // A load that lands while the articles pane is still fading in must not
    // focus a row that is display:none.
    props.whenPaneShown(() => {
      const row = articleListElement?.querySelector<HTMLElement>(
        `[data-index="${index}"]`,
      );
      row?.focus({ preventScroll: true });
      if (options?.scroll ?? true) row?.scrollIntoView({ block: "nearest" });
    });
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
    selectRows(next.indexes);
  }
  // Ctrl/Cmd moves the focus cursor only; Space commits the change. Without
  // the modifier, movement acts like a click and selects just this row.
  function moveTo(index: number, event: KeyboardEvent) {
    if (!list.rows().length) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) focusArticleAt(index);
    else selectArticle(index, event);
  }
  function moveSelection(offset: number, event: KeyboardEvent) {
    const count = list.rows().length;
    moveTo((focusedIndex() + offset + count) % count, event);
  }
  function toggleSelectionAtCursor() {
    const index = focusedIndex();
    const indexes = new Set(selectedIndexes());
    if (indexes.has(index)) indexes.delete(index);
    else indexes.add(index);
    setSelectionAnchor(index);
    selectRows(indexes);
  }
  function selectAll() {
    selectRows(new Set(list.rows().map((_, index) => index)));
  }
  // No mark-as-read side effect: deleting, not reading, is this reader's flow.
  function openOriginalInNewTab() {
    for (const index of selectedIndexes()) {
      const url = list.rows()[index]?.url;
      if (url) window.open(url, "_blank", "noopener");
    }
  }
  // Opening moves focus with the pane (#816): on a narrow screen the pane
  // switch hides the list holding focus, which would drop it to <body> and
  // strand the keyboard there.
  function showReaderPane() {
    props.focusPane("reader");
    props.whenPaneShown(() =>
      readerPaneElement?.focus({ preventScroll: true }),
    );
  }
  function backToList() {
    props.focusPane("articles");
    focusArticleAt(focusedIndex());
  }
  function handleArticleKeys(event: KeyboardEvent) {
    const command = mapArticleKey(event);
    // A showModal() dialog sits on top of the list, so its keys can't reach
    // here; the check covers a non-modal one.
    if (!command || isTextEntry(event.target) || isDialogOpen()) return;
    switch (command) {
      case "next":
        moveSelection(1, event);
        return;
      case "previous":
        moveSelection(-1, event);
        return;
      case "first":
        moveTo(0, event);
        return;
      case "last":
        moveTo(list.rows().length - 1, event);
        return;
      case "toFeeds": {
        const node = selectedNode();
        if (!node) return;
        event.preventDefault();
        props.focusPane("sources");
        props.whenPaneShown(() => focusTreeRow(treeNodeKey(node)));
        return;
      }
      case "read":
        event.preventDefault();
        if (!list.rows()[focusedIndex()]) return;
        // The row's click: this article alone, in the reader.
        selectArticle(focusedIndex());
        showReaderPane();
        return;
      case "toggleSelection":
        event.preventDefault();
        toggleSelectionAtCursor();
        return;
      case "delete":
        event.preventDefault();
        removeSelected(event);
        return;
      case "toggleRead":
        event.preventDefault();
        setSelectedRead(!allSelectedRead());
        return;
      case "selectAll":
        event.preventDefault();
        selectAll();
        return;
      // The reader has no close of its own, since it always shows what the
      // single selection opened, so `o` toggles the pane.
      case "open":
        event.preventDefault();
        if (props.pane() === "reader") backToList();
        else showReaderPane();
        return;
      case "openOriginal":
        event.preventDefault();
        openOriginalInNewTab();
        return;
      case "refresh":
        event.preventDefault();
        void refreshCurrentView();
        return;
      case "help":
        event.preventDefault();
        // DialogHost captures the focused row and hands focus back on close.
        void helpDialog();
    }
  }
  // The reader pane's half of the `o` toggle (#816). Once opening has moved
  // focus here, which a narrow screen requires, this is the only place the
  // key can be heard. Every other key keeps its browser meaning, so the pane
  // scrolls from the keyboard.
  function handleReaderKeys(event: KeyboardEvent) {
    if (mapArticleKey(event) !== "open") return;
    if (isTextEntry(event.target) || isDialogOpen()) return;
    event.preventDefault();
    backToList();
  }

  async function shareSelected() {
    const article = selected();
    if (!article) return;
    // The share sheet needs no feedback; the clipboard fallback does.
    const outcome = await shareArticle(article);
    if (outcome === "copied") announce("Article link copied to the clipboard.");
    else if (outcome === "failed")
      reportMessage("Could not share the article.");
  }
  async function copyToClipboard(url: string, announcement: string) {
    try {
      await navigator.clipboard.writeText(url);
      announce(announcement);
    } catch {
      reportMessage("Could not access the clipboard.");
    }
  }

  async function addNewFolder() {
    const name = await promptDialog("New folder", "Folder name", {
      confirmLabel: "Create",
    });
    if (!name?.trim()) return;
    clearProblem();
    try {
      await api("/folders", folderResponse, {
        json: { name },
        method: "POST",
        request: createFolderRequest,
      });
      await loadTree();
    } catch (cause) {
      reportError(cause, "Could not create the folder");
    }
  }
  function openDiscovery(folder?: string) {
    setDiscoveryFolder(folder);
    props.focusPane("sources");
    setShowDiscovery(true);
  }
  async function showProperties(node = editableNode()) {
    if (!node) return;
    if (node.type === "source") {
      setEditingSource(node);
      openDiscovery();
      return;
    }
    const name = await promptDialog("Rename folder", "Folder name", {
      confirmLabel: "Rename",
      initial: node.name,
    });
    if (!name?.trim() || name === node.name) return;
    clearProblem();
    try {
      await api("/folders", updatedFolderResponse, {
        json: { folderId: Number(node.uid), folderName: name },
        method: "PATCH",
        request: updateFolderRequest,
      });
      await loadTree();
    } catch (cause) {
      reportError(cause, "Could not rename the folder");
    }
  }
  // Per-source snooze (#725). Parsing and saving continue on the server
  // during the pause; this only stores the timestamp and reloads the tree,
  // whose badges and unread list suppress the source until it lapses.
  async function snoozeNode(
    node: Extract<TreeNode, { type: "source" }>,
    pausedUntil: string | null,
  ) {
    clearProblem();
    try {
      await api("/source/snooze", snoozedSourceResponse, {
        json: { pausedUntil, sourceId: Number(node.uid) },
        method: "PATCH",
        request: snoozeSourceRequest,
      });
      await loadTree();
      announce(pausedUntil === null ? "Feed unsnoozed." : "Feed snoozed.");
    } catch (cause) {
      reportError(
        cause,
        pausedUntil === null
          ? "Could not unsnooze the feed"
          : "Could not snooze the feed",
      );
    }
  }
  // Right-click and long-press menus (#721) act on the clicked row without
  // selecting it: the article list, its cursor and the reading position all
  // belong to the selection, which the menu leaves alone. Manual ordering
  // stays a non-feature, so there is no re-filing action.
  function openTreeContext(x: number, y: number, node: ListNode) {
    // Today has no feed URL to copy, no properties to edit and no
    // subscription to remove; the tree item still swallows the native menu.
    if (node.type === "view") return;
    const items: ContextMenuItem[] =
      node.type === "folder"
        ? [
            {
              kind: "action",
              label: "Rename folder",
              onSelect: () => void showProperties(node),
            },
            {
              danger: true,
              disabled: !isEmptyFolder(node),
              kind: "action",
              label: "Delete folder",
              onSelect: () => void removeNode(node),
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
              onSelect: () => void showProperties(node),
            },
            { kind: "separator" },
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
            { kind: "separator" },
            {
              danger: true,
              kind: "action",
              label: "Unsubscribe",
              onSelect: () => void removeNode(node),
            },
          ];
    setContextMenu({ items, x, y });
  }
  async function removeNode(node = editableNode()) {
    if (!node) return;
    if (!isEmptyFolder(node) && node.type === "folder") {
      reportMessage("Folder is not empty");
      return;
    }
    if (
      !(await confirmDialog(
        `Delete "${node.name}"?`,
        node.type === "source"
          ? "You unsubscribe from this feed, and its articles leave your lists."
          : "The folder is removed. It holds no feeds.",
        { confirmLabel: "Delete", danger: true },
      ))
    )
      return;
    try {
      clearProblem();
      const id = Number(node.uid);
      await (node.type === "source"
        ? api("/source", removedIdResponse, {
            json: { removeSourceId: id },
            method: "DELETE",
            request: removeSourceRequest,
          })
        : api("/folders", removedIdResponse, {
            json: { removeFolderId: id },
            method: "DELETE",
            request: removeFolderRequest,
          }));
      const current = selectedNode();
      if (!current || treeNodeKey(current) !== treeNodeKey(node)) {
        // A menu target other than the selection: reading stays where it
        // is, unless the list shows rows of the feed that just went away.
        await loadTree();
        const listsRemoved =
          node.type === "source" &&
          list.rows().some((item) => item.sourceId === Number(node.uid));
        const search = activeSearch();
        if (listsRemoved && search) await runSearch(search);
        else if (listsRemoved && current) await select(current);
        return;
      }
      // Clearing the list also stops a pending delete from rolling its rows
      // back.
      setSelectedNode(undefined);
      emptyList();
      // The source, and everything under a deleted folder, is gone: no
      // snapshot may point at it, and none of its articles keep a reading
      // position (#718).
      restore.store.clear();
      await loadTree();
      // The deleted row's node is gone, dropping focus to document.body.
      queueMicrotask(() => focusTreeRow());
    } catch (cause) {
      reportError(cause, "Could not delete it");
    }
  }

  function closeDiscovery(): boolean {
    const wasEditing = editingSource() !== undefined;
    setShowDiscovery(false);
    setDiscoveryFolder(undefined);
    setEditingSource(undefined);
    if (props.initialDiscovery) props.navigate("/");
    return wasEditing;
  }

  return (
    <main class="dashboard">
      <h1 class="sr-only">FeedFathom</h1>
      <div aria-live="polite" class="sr-only" role="status">
        {liveText()}
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
      <Show when={problem()}>
        {(shown) => (
          <div class="dashboard-alert" role="alert">
            <p>{shown().message}</p>
            <Show when={shown().details}>
              {(details) => <FailureDetails admin={isAdmin()} {...details()} />}
            </Show>
            <button type="button" onClick={() => void refreshCurrentView()}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <Show when={newArticles.arrived() > 0}>
        <div class="update-banner" role="status">
          <span>
            {newArticles.arrived()} new article
            {newArticles.arrived() === 1 ? "" : "s"}.
          </span>
          <button type="button" onClick={() => void refreshCurrentView()}>
            Refresh
          </button>
        </div>
      </Show>
      <Show when={!showDiscovery() || !authenticated()}>
        <SourcesPane
          addSourceRef={(element) => (addSourceButton = element)}
          admin={isAdmin()}
          editable={Boolean(editableNode())}
          failure={treeFailed()}
          filter={treeFilter()}
          focused={props.pane() === "sources"}
          loading={treeLoading()}
          onAddFolder={() => void addNewFolder()}
          onAddSource={() => openDiscovery()}
          onContext={openTreeContext}
          onDelete={() => void removeNode()}
          onFilter={setTreeFilter}
          onImport={() => props.navigate("/options#import-opml")}
          onOptions={() => props.navigate("/options")}
          onProperties={() => void showProperties()}
          onRetry={() => void refreshCurrentView()}
          onSelect={(node) => void select(node)}
          propertiesRef={(element) => (propertiesButton = element)}
          ref={(element) => (sourcesPaneElement = element)}
          selected={selectedNode()}
          tree={tree()}
          visibleTree={visibleTree()}
        />
        <ArticlesPane
          admin={isAdmin()}
          allSelectedRead={allSelectedRead()}
          backPane={props.backPane}
          feedsFailed={Boolean(treeFailed())}
          feedsMissing={feedsPending() || feedsUnavailable()}
          filter={articleFilter()}
          focused={props.pane() === "articles"}
          isFocused={isFocused}
          isSelected={isSelected}
          listRef={(element) => (articleListElement = element)}
          loading={list.loading()}
          onAddFeed={() => openDiscovery(selectedNode()?.uid)}
          onDelete={removeSelected}
          onEditFeed={() => void showProperties()}
          onExitSearch={() => void exitSearch()}
          onFilter={changeArticleFilter}
          onKeyDown={handleArticleKeys}
          onOptions={() => props.navigate("/options")}
          onRefresh={() => void refreshCurrentView()}
          onRetryFeed={() => void retrySelectedSource()}
          onRowClick={(index, event) => {
            selectArticle(index, event);
            props.focusPane("reader");
          }}
          onRowHover={(id) => fetches.hover(id, reader.opened()?.id)}
          onRowLeave={() => fetches.leave()}
          onRowPress={(event, id) =>
            fetches.press(event, id, reader.opened()?.id)
          }
          onRowPressCancel={() => fetches.cancelPress()}
          onScroll={(element) => {
            void loadMoreArticles(element);
            recordListScroll(element.scrollTop);
          }}
          onSearch={() => void runSearch(searchTerms())}
          onSearchTerms={setSearchTerms}
          onSelectAll={() => {
            // Clicking focuses this button, outside the list, where the
            // list's keys stop firing; Ctrl+A already runs from inside it.
            selectAll();
            if (list.rows().length) focusArticleAt(0, { scroll: false });
          }}
          onToggleRead={() => setSelectedRead(!allSelectedRead())}
          retry={retryState()}
          rows={list.rows()}
          searchTerms={searchTerms()}
          searching={Boolean(activeSearch())}
          selected={selectedNode()}
          selectedCount={selectedIndexes().size}
          signedIn={authenticated()}
          // The feeds loading is the list loading too, until something is
          // selected: a restored session opens its feed before the tree is
          // revealed, and its rows must be there to take focus.
          skeleton={list.loading() || (treeLoading() && !selectedNode())}
        />
        <ReaderPane
          backPane={props.backPane}
          emptyMessage={
            treeFailed()
              ? "Nothing to read until the feeds load."
              : feedsPending()
                ? "Loading…"
                : "Select an article to read."
          }
          feedName={feedName}
          focused={props.pane() === "reader"}
          hasArticle={Boolean(selected())}
          onDelete={removeSelected}
          onKeyDown={handleReaderKeys}
          onModeChange={() => selectRows(new Set(selectedIndexes()))}
          onOptions={() => props.navigate("/options")}
          onScroll={recordReaderScroll}
          onShare={() => void shareSelected()}
          reader={reader}
          readerRef={(element) => (readerElement = element)}
          ref={(element) => (readerPaneElement = element)}
        />
      </Show>
      <Show when={showDiscovery() && authenticated()}>
        <FeedDiscovery
          admin={isAdmin()}
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
          initialFolder={discoveryFolder()}
          initialNewsletter={props.initialNewsletter ?? false}
          mailDomain={session()?.mailDomain}
          pane={props.pane}
          close={() => {
            const wasEditing = closeDiscovery();
            if (!props.initialDiscovery)
              queueMicrotask(() =>
                (wasEditing ? propertiesButton : addSourceButton)?.focus(),
              );
          }}
          saved={async (sourceId) => {
            const wasEditing = closeDiscovery();
            const savedNode = findNode(
              await loadTree(),
              "source",
              sourceId.toString(),
            );
            if (!savedNode) return;
            await select(savedNode);
            // Editing renames or moves an existing feed; nothing to fetch.
            if (wasEditing) return;
            // Subscribing only queues the fetch (the worker does it), so the
            // list can be empty right after. Poll briefly rather than showing
            // a blank pane; bail if the user navigated away.
            for (
              let attempt = 0;
              attempt < 5 &&
              list.rows().length === 0 &&
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
