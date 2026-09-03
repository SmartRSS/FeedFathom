import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  articleResponse,
  articlesResponse,
  folderResponse,
  removedArticlesResponse,
  removedIdResponse,
  treeResponse,
  updatedFolderResponse,
  type Article,
  type ArticleSummary,
  type TreeNode,
} from "#shared/contracts/responses.ts";
import { safeArticleUrl } from "#shared/util/safe-url.ts";
import {
  faviconUrls,
  findNode,
  findParentFolderUid,
  sourceIds,
  treeNodeKey,
  withDecrementedUnread,
} from "./dashboard-behavior.ts";
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
import { resolvedTheme } from "./preferences.ts";
// Raw markup, not <img src>: every icon is fill/stroke="currentColor", which
// only resolves against the row's text color when the SVG is in the page's
// DOM. As an external image it would need per-case light/dark guessing.
import addFolderRaw from "./assets/icons/Document/folder-add-fill.svg?raw";
import addRaw from "./assets/icons/System/add-box-fill.svg?raw";
import settingsRaw from "./assets/icons/System/settings-5-fill.svg?raw";
import detailsRaw from "./assets/icons/System/information-fill.svg?raw";
import removeRaw from "./assets/icons/System/delete-bin-7-fill.svg?raw";
import selectAllRaw from "./assets/icons/System/check-double-fill.svg?raw";

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
  const [treeLoading, setTreeLoading] = createSignal(true);
  const [articles, setArticles] = createSignal<ArticleSummary[]>([]);
  const [articlesLoading, setArticlesLoading] = createSignal(false);
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
  // A screen reader can't be detected, so this always renders (see the
  // aria-live region below); it is visually hidden either way and only gets
  // real text when high contrast mode is off.
  const [accessibilityAnnouncement, setAccessibilityAnnouncement] =
    createSignal("");
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
      setSelectedNode(findNode(nextTree, current.type, current.uid));
    }
    return nextTree;
  }
  async function addNewFolder() {
    const name = prompt("Folder name");
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
    try {
      const nextTree = await loadTree();
      await preloadFavicons(nextTree);
      setAuthenticated(true);
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
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
  async function select(node: TreeNode) {
    props.focusPane("articles");
    setSelectedNode(node);
    const selection = selectionGuard.start();
    articleAbortController?.abort();
    const ids = sourceIds(node);
    if (!ids.length) {
      setArticles([]);
      void setArticleSelection(new Set<number>(), selection);
      setFocusedIndex(0);
      setSelectionAnchor(undefined);
      return;
    }
    setArticlesLoading(true);
    const controller = new AbortController();
    articleAbortController = controller;
    try {
      setOpenedArticle(undefined);
      setReaderContent(undefined);
      const nextArticles = await api("/articles", articlesResponse, {
        body: JSON.stringify({ sources: ids }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!selectionGuard.isCurrent(selection)) return;
      setArticles(nextArticles);
      const nextIndexes = new Set(nextArticles.length ? [0] : []);
      void setArticleSelection(nextIndexes, selection);
      setSelectionAnchor(nextArticles.length ? 0 : undefined);
      queueMicrotask(() => focusArticleAt(0));
    } catch (cause) {
      if (!selectionGuard.isCurrent(selection)) return;
      reportError(cause, "Could not load articles");
    } finally {
      if (selectionGuard.isCurrent(selection)) setArticlesLoading(false);
    }
  }
  async function showProperties() {
    const node = selectedNode();
    if (!node) return;
    if (node.type === "source") {
      setEditingSource(node);
      props.focusPane("sources");
      setShowDiscovery(true);
      return;
    }
    const name = prompt("Folder name", node.name);
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
  async function removeSelectedNode() {
    const node = selectedNode();
    if (!node) return;
    if (node.type === "folder" && node.children?.length) {
      setError("Folder is not empty");
      return;
    }
    if (!confirm(`Delete "${node.name}"?`)) return;
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
    try {
      const opened = await api(
        `/article?article=${article.id}`,
        articleResponse,
      );
      if (!isCurrent()) return;
      setOpenedArticle(opened);

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
      setSelectedNode(findNode(nextTree, current.type, current.uid));
    }
    // The removed rows' nodes are gone, dropping focus to document.body.
    queueMicrotask(() => focusArticleAt(restoreIndex));

    deletion
      .then(() =>
        loadTree().catch((cause) =>
          reportError(cause, "Could not refresh tree"),
        ),
      )
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
      event.key.toLowerCase() === "a" &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      void setArticleSelection(new Set(articles().map((_, index) => index)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      for (const index of selectedIndexes()) {
        const value = articles()[index]?.url;
        const url = value ? safeArticleUrl(value, window.location.href) : "";
        if (url) window.open(url, "_blank", "noopener");
      }
    } else if (event.key === "ArrowLeft") {
      const node = selectedNode();
      if (!node) return;
      event.preventDefault();
      props.focusPane("sources");
      document
        .querySelector<HTMLElement>(`[data-tree-key="${treeNodeKey(node)}"]`)
        ?.focus();
    }
  }
  return (
    <main class="dashboard">
      <h1 class="sr-only">FeedFathom</h1>
      <div aria-live="polite" class="sr-only" role="status">
        {accessibilityAnnouncement()}
      </div>
      <Show when={error()}>
        {(message) => (
          <p class="dashboard-alert" role="alert">
            {message()}
          </p>
        )}
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
            <ul
              aria-busy={treeLoading()}
              aria-label="Feeds"
              class="tree"
              role="tree"
            >
              <For each={tree()}>
                {(node) => (
                  <TreeItem
                    focused={focusedTreeKey() === treeNodeKey(node)}
                    focusedKey={focusedTreeKey()}
                    node={node}
                    onFocus={(item) => setFocusedTreeKey(treeNodeKey(item))}
                    select={(item) => void select(item)}
                    selected={selectedNode()}
                  />
                )}
              </For>
            </ul>
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
              aria-label="delete articles"
              disabled={selectedIndexes().size === 0}
              onClick={() => removeSelected()}
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
          <div
            aria-busy={articlesLoading()}
            aria-label="Articles"
            aria-multiselectable="true"
            class="article-list"
            role="listbox"
            onKeyDown={handleArticleKeys}
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
                        selected: selectedIndexes().has(index()),
                      }}
                      data-index={index()}
                      href={safeArticleUrl(article.url, window.location.href)}
                      onClick={(event) => {
                        event.preventDefault();
                        selectArticle(index(), event);
                        props.focusPane("reader");
                      }}
                      role="option"
                      tabIndex={focusedIndex() === index() ? 0 : -1}
                      aria-selected={selectedIndexes().has(index())}
                    >
                      <span class="title">{article.title}</span>
                      <span class="details">
                        <span>{article.author}</span>
                        <time datetime={article.publishedAt || undefined}>
                          {article.publishedAt
                            ? new Date(article.publishedAt).toLocaleString()
                            : ""}
                        </time>
                      </span>
                    </a>
                  </>
                )}
              </For>
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
