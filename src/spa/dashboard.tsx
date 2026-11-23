import {
  createEffect,
  createMemo,
  createProjection,
  createSignal,
  flush,
  onCleanup,
  onSettled,
  Show,
  untrack,
  type Accessor,
} from "solid-js";
import type { Static } from "typebox";
import {
  articleResponse,
  articlesResponse,
  folderResponse,
  removedArticlesResponse,
  removedIdResponse,
  type sessionResponse,
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
  withUnreadCounts,
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
import type { Route } from "./routes.ts";
import { api, failureDetails, messageOf, requestSession } from "./api.ts";
import { FailureDetails, type RetryState } from "./failure-details.tsx";
import { deleteTrace } from "./delete-trace.ts";
import {
  deleteTraceHeader,
  unreadCountsHeader,
} from "#shared/contracts/headers.ts";
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
import { showUnreadTotal } from "./news-signal.ts";
import { createNewArticleSignal } from "./new-article-signal.ts";
import { createOfflineSync } from "./offline-sync.ts";
import { SourcesPane, type FeedsFailure } from "./sources-pane.tsx";
import { ArticlesPane } from "./articles-pane.tsx";
import { ReaderPane } from "./reader-pane.tsx";

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

function parseUnreadCountsHeader(
  response: Response,
): Map<string, number> | undefined {
  const raw = response.headers.get(unreadCountsHeader);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const counts = new Map<string, number>();
  for (const [sourceUid, count] of Object.entries(parsed)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return undefined;
    counts.set(sourceUid, count);
  }
  return counts;
}

const sessionRetryFirstMs = 1000;
const sessionRetryMaxMs = 60_000;

const articlesNoun = (count: number) =>
  count === 1 ? "Article" : `${count} articles`;

function createRowFlags(indexes: Accessor<ReadonlySet<number>>) {
  const flags = createProjection<Record<number, boolean>>((draft) => {
    const next = indexes();
    for (const key of Object.keys(draft))
      if (!next.has(Number(key))) delete draft[Number(key)];
    for (const index of next) draft[index] = true;
  }, {});
  return (index: number) => flags[index] === true;
}

export function Dashboard(props: {
  backPane(): void;
  closeDiscovery(): Promise<void>;
  discovery(): boolean;
  focusPane(next: DashboardPane): void;
  handleUnauthorized(cause: unknown): boolean;
  navigate(to: string): void;
  openDiscovery(): void;
  pane(): DashboardPane;
  preview?: Extract<Route, { name: "preview" }> | undefined;
  whenPaneShown(run: () => void): void;
}) {
  let disposed = false;
  let sourcesPaneElement: HTMLElement | undefined;
  let addSourceButton: HTMLButtonElement | undefined;
  let propertiesButton: HTMLButtonElement | undefined;
  let articleListElement: HTMLElement | undefined;
  let readerPaneElement: HTMLElement | undefined;
  let readerElement: HTMLElement | undefined;

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
  const [liveText, setLiveText] = createSignal("");
  const announce = (message: string) => {
    setLiveText("");
    setTimeout(() => setLiveText(message), 100);
  };
  const [session, setSession] = createSignal<Static<typeof sessionResponse>>();
  let sessionRetry: ReturnType<typeof setTimeout> | undefined;
  const loadSession = (retryAfterMs: number) => {
    requestSession().then(setSession, () => {
      sessionRetry = setTimeout(
        () => loadSession(Math.min(retryAfterMs * 2, sessionRetryMaxMs)),
        retryAfterMs,
      );
    });
  };
  loadSession(sessionRetryFirstMs);
  onCleanup(() => clearTimeout(sessionRetry));
  const isAdmin = () => session()?.user?.isAdmin ?? false;

  const [tree, setTree] = createSignal<TreeNode[]>([]);
  const [treeFilter, setTreeFilter] = createSignal("");
  const [treeLoading, setTreeLoading] = createSignal(true);
  const [treeFailed, setTreeFailed] = createSignal<FeedsFailure>();
  const [authenticated, setAuthenticated] = createSignal(false);
  const [selectedNode, setSelectedNode] = createSignal<ListNode>();
  const visibleTree = createMemo(() =>
    filterTree(withTodayNode(tree(), todayView.get()), treeFilter()),
  );
  const editableNode = () => {
    const node = selectedNode();
    return node?.type === "view" ? undefined : node;
  };
  const feedsUnavailable = () => Boolean(treeFailed()) && !tree().length;
  const feedsPending = () => treeLoading() && !tree().length;
  const sourceNames = createMemo(() => {
    const names = new Map<string, string>();
    const stack: TreeNode[] = [...tree()];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.type === "source") names.set(node.uid, node.name);
      else stack.push(...node.children);
    }
    return names;
  });
  const feedName = (article: { sourceId: number }) =>
    sourceNames().get(String(article.sourceId));

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
  createEffect(
    () => !feedFilterBox.get() && Boolean(treeFilter()),
    (stale) => {
      if (stale) setTreeFilter("");
    },
  );
  createEffect(articleSearchBox.get, (shown) => {
    if (shown) return;
    setSearchTerms("");
    untrack(() => void exitSearch());
  });

  const [selectedIndexes, setSelectedIndexes] = createSignal(new Set<number>());
  const [focusedIndex, setFocusedIndex] = createSignal(0);
  const [selectionAnchor, setSelectionAnchor] = createSignal<number>();
  const isFocused = createRowFlags(() => new Set([focusedIndex()]));
  const isSelected = createRowFlags(selectedIndexes);
  const selected = () => {
    const index = soleSelectedIndex(selectedIndexes());
    return index === undefined ? undefined : list.rows()[index];
  };

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

  const restore = new SessionRestore(
    new ReadingSessionStore({
      local: localStorage,
      remember: () => untrack(rememberReadingPosition.get),
      resumingUpdate: takeUpdateReload(),
      session: sessionStorage,
    }),
  );
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
  createEffect(
    () => {
      const state = listState();
      return selectedNode() || state.search ? state : undefined;
    },
    (state) => {
      if (state) restore.record(state);
    },
  );
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
  createEffect(reader.displayed, (item) => {
    if (!item) return;
    const ratio = restore.takeReaderScroll(item.article.id);
    if (ratio === undefined) return;
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

  const unreadTotal = createMemo(() => totalUnread(tree()));
  onSettled(() => showUnreadTotal(unreadTotal));
  let treeAbortController: AbortController | undefined;
  let treeRequestPromise: Promise<TreeNode[]> | undefined;
  onCleanup(() => {
    disposed = true;
    treeAbortController?.abort();
  });
  const newArticles = createNewArticleSignal({
    enabled: backgroundPoll.get,
    hidden: () => document.hidden,
    listening: () => authenticated() && backgroundPoll.get(),
    loadTree,
    onPollFailure: (cause) => props.handleUnauthorized(cause),
  });
  createOfflineSync(tree, authenticated);

  const showDiscovery = () => props.preview !== undefined || props.discovery();
  const [discoveryFolder, setDiscoveryFolder] = createSignal<string>();
  const [editingSource, setEditingSource] =
    createSignal<Extract<TreeNode, { type: "source" }>>();
  const editedSource = createMemo(() => {
    const source = editingSource();
    return (
      source && {
        homeUrl: source.homeUrl,
        name: source.name,
        parentUid: findParentFolderUid(tree(), source.uid),
        uid: source.uid,
        xmlUrl: source.xmlUrl,
      }
    );
  });
  const [contextMenu, setContextMenu] = createSignal<
    { items: ContextMenuItem[]; key: string; x: number; y: number } | undefined
  >();

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
  function applyTree(nextTree: TreeNode[]) {
    setTree(nextTree);
    const current = selectedNode();
    if (current && current.type !== "view")
      setSelectedNode(findNode(nextTree, current.type, current.uid));
  }
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
    queueMicrotask(() => {
      if (document.activeElement && document.activeElement !== document.body)
        return;
      focusTreeRow();
    });
  };

  onSettled(() => void boot());
  async function boot() {
    void reader.probe();
    const snapshot = restore.store.takeSnapshot();
    const restored = props.preview ? undefined : snapshot;
    if (restored) restore.begin();
    try {
      const unloaded = tree();
      const fresh = loadTree();
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
    if (resolvedTheme() !== "high-contrast")
      setTimeout(
        () =>
          announce(
            "A high-contrast theme is available in accessibility settings.",
          ),
        2000,
      );
  }

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
    flush();
    if (search) {
      if (node) setSelectedNode(node);
      setSearchTerms(search);
      await runSearch(search, snapshot);
    } else if (node) await select(node, snapshot);
  }

  function selectRows(indexes: Set<number>, rows = list.rows()) {
    setSelectedIndexes(indexes);
    const index = soleSelectedIndex(indexes);
    const article = index === undefined ? undefined : rows[index];
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
        if (
          markReadPolicy.get() === "on-open" &&
          !article.read &&
          articleFilter() === "all"
        )
          void markArticlesRead([article.id], true);
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
      const indexes = new Set(resumed.indexes);
      selectRows(indexes, rows);
      setSelectionAnchor(resumed.anchor);
      queueMicrotask(() => focusArticleAt(resumed.focus));
      const index = soleSelectedIndex(indexes);
      const opened = index === undefined ? undefined : rows[index];
      if (opened) {
        restore.resumeReaderAt(opened.id);
        props.focusPane("reader");
      }
      queueMicrotask(() =>
        requestAnimationFrame(() => {
          if (articleListElement)
            articleListElement.scrollTop = snapshot.listScrollTop;
          restore.finish();
        }),
      );
      return;
    }
    const opensFirst = rows.length > 0 && !readerHidden();
    selectRows(new Set(opensFirst ? [0] : []), rows);
    setSelectionAnchor(rows.length ? 0 : undefined);
    queueMicrotask(() => focusArticleAt(0));
    restore.record({
      articleFilter: articleFilter(),
      articleId: opensFirst ? rows[0]?.id : undefined,
      listScrollTop: 0,
    });
    if (snapshot) restore.abandon();
  }

  async function select(node: ListNode, snapshot?: AppSnapshot) {
    if (!snapshot) restore.cancel();
    props.focusPane("articles");
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
    if (!activeSearch() && !snapshot) {
      setArticleFilter("all");
      flush();
    }
    setActiveSearch(query);
    props.focusPane("articles");
    clearProblem();
    await showList(searchScope(query), snapshot);
  }
  async function exitSearch() {
    if (!activeSearch()) return;
    setActiveSearch("");
    const node = selectedNode();
    if (node) await select(node);
    else list.clear();
  }
  function changeArticleFilter(next: ArticleFilter) {
    if (next === articleFilter()) return;
    setArticleFilter(next);
    flush();
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
  function topUpArticles() {
    queueMicrotask(() => {
      if (articleListElement) void loadMoreArticles(articleListElement);
    });
  }

  function dropRows(indexes: Set<number>) {
    const { nextIndex, remaining } = removalOutcome(list.rows(), indexes);
    const next = remaining[nextIndex] ? nextIndex : undefined;
    list.setRows(remaining);
    topUpArticles();
    selectRows(new Set(next === undefined ? [] : [next]), remaining);
    setSelectionAnchor(next);
    queueMicrotask(() => focusArticleAt(next ?? 0));
  }
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
    else
      dropRows(
        new Set(
          rows.flatMap((article, index) =>
            affected.has(article.id) ? [index] : [],
          ),
        ),
      );
    try {
      let unreadCounts: Map<string, number> | undefined;
      await api("/articles", removedArticlesResponse, {
        json: { articleIdList: ids, read },
        method: "PATCH",
        onResponse: (response) => {
          unreadCounts = parseUnreadCountsHeader(response);
        },
        request: readArticlesRequest,
      });
      if (announcement) announce(announcement);
      if (read) restore.store.clearReaderScrolls(ids);
      if (unreadCounts) applyTree(withUnreadCounts(tree(), unreadCounts));
      else await loadTree();
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
    let unreadCounts: Map<string, number> | undefined;
    const deletion = api("/articles", removedArticlesResponse, {
      headers: { [deleteTraceHeader]: deleteTrace(trigger) },
      json: { removedArticleIdList: ids },
      method: "DELETE",
      onResponse: (response) => {
        unreadCounts = parseUnreadCountsHeader(response);
      },
      request: removeArticlesRequest,
    });
    applyUnreadDeltas(readStateDeltas(rows, ids, true));
    dropRows(indexes);
    deletion
      .then(() => {
        announce(`${articlesNoun(ids.length)} deleted.`);
        restore.store.clearReaderScrolls(ids);
        if (unreadCounts) {
          applyTree(withUnreadCounts(tree(), unreadCounts));
          return undefined;
        }
        return loadTree().catch((cause: unknown) =>
          reportError(cause, "Could not refresh your feeds"),
        );
      })
      .catch((cause: unknown) => {
        reportError(cause, "Could not delete articles");
        if (!listSignal.aborted) {
          list.setRows(rows);
          selectRows(new Set(indexes), rows);
          setFocusedIndex(Math.min(...indexes));
          setSelectionAnchor(Math.min(...indexes));
        }
        loadTree().catch((reloadCause: unknown) =>
          reportError(reloadCause, "Could not refresh your feeds"),
        );
      });
  }

  createEffect(
    () =>
      markReadPolicy.get() === "on-scroll-past" &&
      !restore.restoring() &&
      !list.loading() &&
      list.rows(),
    (rows) => {
      if (!rows || !rows.length || !articleListElement) return undefined;
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      return observeScrollPast({
        eligible: (id) => {
          const article = rowsById.get(id);
          return (
            article !== undefined && !article.read && selected()?.id !== id
          );
        },
        flush: (ids) => void markArticlesRead(ids, true),
        list: articleListElement,
        passiveFirstPass: restore.takePassiveFirstPass(),
        rowId: (row) =>
          row instanceof HTMLElement
            ? rows[Number(row.dataset["index"])]?.id
            : undefined,
      });
    },
  );

  function focusArticleAt(index: number, options?: { scroll?: boolean }) {
    setFocusedIndex(index);
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
  function openOriginalInNewTab() {
    for (const index of selectedIndexes()) {
      const url = list.rows()[index]?.url;
      if (url) window.open(url, "_blank", "noopener");
    }
  }
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
        void helpDialog();
    }
  }
  function handleReaderKeys(event: KeyboardEvent) {
    if (mapArticleKey(event) !== "open") return;
    if (isTextEntry(event.target) || isDialogOpen()) return;
    event.preventDefault();
    backToList();
  }

  async function shareSelected() {
    const article = selected();
    if (!article) return;
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
  function openDiscovery(
    folder?: string,
    editing?: Extract<TreeNode, { type: "source" }>,
  ) {
    setDiscoveryFolder(folder);
    setEditingSource(editing);
    props.openDiscovery();
  }
  async function showProperties(node = editableNode()) {
    if (!node) return;
    if (node.type === "source") {
      openDiscovery(undefined, node);
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
  function openTreeContext(x: number, y: number, node: ListNode) {
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
    setContextMenu({ items, key: treeNodeKey(node), x, y });
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
        await loadTree();
        const listsRemoved =
          node.type === "source" &&
          list.rows().some((item) => item.sourceId === Number(node.uid));
        const search = activeSearch();
        if (listsRemoved && search) await runSearch(search);
        else if (listsRemoved && current) await select(current);
        return;
      }
      setSelectedNode(undefined);
      emptyList();
      restore.store.clear();
      await loadTree();
      queueMicrotask(() => focusTreeRow());
    } catch (cause) {
      reportError(cause, "Could not delete it");
    }
  }

  function closeDiscovery(): Promise<void> {
    if (!props.preview) return props.closeDiscovery();
    props.navigate("/");
    return Promise.resolve();
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
          contextKey={contextMenu()?.key}
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
          editing={editedSource()}
          focusPane={props.focusPane}
          handleUnauthorized={props.handleUnauthorized}
          initialFeedUrl={props.preview?.feedUrl}
          initialFolder={discoveryFolder()}
          initialNewsletter={props.preview?.newsletter === true}
          mailDomain={session()?.mailDomain}
          pane={props.pane}
          close={() => {
            const wasEditing = editingSource() !== undefined;
            void closeDiscovery();
            if (!props.preview)
              queueMicrotask(() =>
                (wasEditing ? propertiesButton : addSourceButton)?.focus(),
              );
          }}
          saved={async (sourceId) => {
            const wasEditing = editingSource() !== undefined;
            await closeDiscovery();
            const savedNode = findNode(
              await loadTree(),
              "source",
              sourceId.toString(),
            );
            if (!savedNode) return;
            await select(savedNode);
            if (wasEditing) return;
            for (
              let attempt = 0;
              attempt < 5 &&
              list.rows().length === 0 &&
              selectedNode()?.uid === savedNode.uid;
              attempt++
            ) {
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
