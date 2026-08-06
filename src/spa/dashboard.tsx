import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  removalOutcome,
  soleSelectedIndex,
  transitionArticleSelection,
  type DashboardPane,
} from "./behavior";
import { createSupersessionGuard } from "./supersession";
import { api } from "./api";
import {
  articleResponse,
  articlesResponse,
  folderResponse,
  removedArticlesResponse,
  removedIdResponse,
  treeResponse,
  type Article,
  type ArticleSummary,
  type TreeNode,
} from "../contracts/responses";
import { safeArticleUrl } from "../lib/feed-mapper";
import {
  createExtensionReaderBridge,
  extractReaderContent,
  ReaderExtensionError,
  type ReaderContent,
  type ReaderMode,
} from "./extension-reader";
import { FeedDiscovery } from "./feed-discovery";
import back from "../lib/images/icons/Arrows/arrow-left-fill.svg";
import addFolder from "../lib/images/icons/Document/folder-add-fill.svg";
import add from "../lib/images/icons/System/add-box-fill.svg";
import settings from "../lib/images/icons/System/settings-5-fill.svg";
import details from "../lib/images/icons/System/information-fill.svg";
import remove from "../lib/images/icons/System/delete-bin-7-fill.svg";
import selectAll from "../lib/images/icons/System/check-double-fill.svg";
import arrowDown from "../lib/images/icons/Arrows/chevron-down-fill.svg";
import arrowRight from "../lib/images/icons/Arrows/chevron-right-fill.svg";
import feed from "../lib/images/icons/System/rss-fill.svg";
import folder from "../lib/images/icons/Document/folder-fill.svg";
import folderOpened from "../lib/images/icons/Document/folder-open-fill.svg";

declare global {
  interface Window {
    __treePreload?: Promise<Response>;
  }
}

function ReaderBody(props: { content: ReaderContent }) {
  return props.content.kind === "html" ? (
    <div innerHTML={props.content.content} />
  ) : (
    <div class="reader-plain">{props.content.content}</div>
  );
}

function sourceIds(node: TreeNode): number[] {
  return node.type === "source"
    ? [Number(node.uid)]
    : (node.children ?? []).flatMap(sourceIds);
}

function faviconUrls(node: TreeNode): string[] {
  return node.type === "source"
    ? node.favicon
      ? [node.favicon]
      : []
    : (node.children ?? []).flatMap(faviconUrls);
}

// Favicons already go through the service worker's own cache, so once warm
// this resolves near-instantly -- the point isn't to add a real wait, it's
// to stop the tree's text and its icons from painting a couple of frames
// apart. The timeout bounds the one case where that's not true (a cold
// cache, or a slow/broken favicon): don't hold the skeleton hostage to a
// handful of image fetches when showing the tree without them is better
// than not showing it at all.
const FAVICON_PRELOAD_TIMEOUT_MS = 500;

function preloadFavicons(tree: TreeNode[]): Promise<void> {
  const urls = tree.flatMap(faviconUrls);
  if (!urls.length) return Promise.resolve();
  const loaded = Promise.all(
    urls.map((url) => {
      const image = new Image();
      image.src = url;
      return image.decode().catch(() => {});
    }),
  ).then(() => {});
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, FAVICON_PRELOAD_TIMEOUT_MS),
  );
  return Promise.race([loaded, timeout]);
}

const READER_SKELETON_LINE_WIDTHS = ["95%", "88%", "92%", "70%", "90%", "60%"];

function withDecrementedUnread(
  nodes: TreeNode[],
  deltas: Map<string, number>,
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type === "folder") {
      const children = withDecrementedUnread(node.children, deltas);
      if (children === node.children) return node;
      changed = true;
      return { ...node, children };
    }
    const delta = deltas.get(node.uid);
    if (!delta) return node;
    changed = true;
    return { ...node, unreadCount: Math.max(0, node.unreadCount - delta) };
  });
  return changed ? next : nodes;
}

function findNode(
  nodes: TreeNode[],
  type: TreeNode["type"],
  uid: string,
): TreeNode | undefined {
  const queue = [...nodes];
  for (const node of queue) {
    if (node.type === type && node.uid === uid) return node;
    if (node.type === "folder") queue.push(...node.children);
  }
  return undefined;
}

function unreadCount(node: TreeNode): number {
  return node.type === "source"
    ? (node.unreadCount ?? 0)
    : (node.children ?? []).reduce(
        (count, child) => count + unreadCount(child),
        0,
      );
}

function storedFolderOpen(uid: string) {
  try {
    return localStorage.getItem(`folder:${uid}`) !== "closed";
  } catch {
    return true;
  }
}

function storeFolderOpen(uid: string, open: boolean) {
  try {
    localStorage.setItem(`folder:${uid}`, open ? "open" : "closed");
  } catch {}
}

function TreeItem(props: {
  node: TreeNode;
  select(node: TreeNode): void;
  selected: TreeNode | undefined;
}) {
  const [open, setOpen] = createSignal(storedFolderOpen(props.node.uid));
  const isFolder = () => props.node.type === "folder";
  const children = () =>
    props.node.type === "folder" ? props.node.children : [];
  const unread = () => unreadCount(props.node);
  const favicon = () =>
    props.node.type === "source" ? props.node.favicon : null;
  function toggle() {
    const next = !open();
    setOpen(next);
    storeFolderOpen(props.node.uid, next);
  }
  return (
    <li>
      <button
        class="source"
        classList={{
          folder: isFolder(),
          selected: props.selected === props.node,
          unread: unread() > 0,
        }}
        onClick={() => props.select(props.node)}
      >
        <Show
          when={isFolder()}
          fallback={
            <img
              alt=""
              class="node-icon"
              src={favicon() ?? feed}
              onError={(event) => {
                event.currentTarget.src = feed;
              }}
            />
          }
        >
          <img
            alt="toggle folder"
            class="chevron"
            src={open() ? arrowDown : arrowRight}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          />
          <img alt="" class="node-icon" src={open() ? folderOpened : folder} />
        </Show>
        <span>{props.node.name}</span>
        <Show when={unread()}>{(count) => <em>{count()}</em>}</Show>
      </button>
      <Show when={isFolder() && open()}>
        <ul class="tree nested">
          <For each={children()}>
            {(child) => (
              <TreeItem
                node={child}
                select={props.select}
                selected={props.selected}
              />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

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
      // The service worker already told the user this action succeeded
      // (an optimistic response) before discovering, once back online,
      // that the server definitively rejected it -- nothing else lets
      // the user find out, so surface it here.
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
    const preload = window.__treePreload;
    delete window.__treePreload;
    treeAbortController?.abort();
    const controller = new AbortController();
    treeAbortController = controller;
    const attempt: Promise<TreeNode[]> = (async () => {
      try {
        return (
          await api(
            "/tree",
            treeResponse,
            { signal: controller.signal },
            preload,
          )
        ).tree;
      } catch (cause) {
        // Only treat this as "superseded, defer to whoever's current"
        // when THIS request's own signal is what caused the failure --
        // a newer loadTree() aborting this one shouldn't surface an
        // unrelated "Could not create folder"/"Could not subscribe"
        // toast, but a genuine failure must still propagate even if
        // another loadTree() happened to start around the same time.
        // Deferring to the shared in-flight promise (rather than reading
        // the `tree` signal) matters because abort() settles before the
        // superseding request's own network round trip finishes, so the
        // signal can't yet hold that request's result.
        //
        // Checking `cause` itself (not just `controller.signal.aborted`)
        // matters too: a controller can be aborted AFTER its fetch
        // already resolved, while a later step (JSON parsing, schema
        // validation) is still throwing a genuine, unrelated error --
        // `signal.aborted` alone can't tell those apart and would mask
        // a real bug as a silent supersession.
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
    await preloadFavicons(nextTree);
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
      await loadTree();
      setAuthenticated(true);
    } catch (cause) {
      if (props.handleUnauthorized(cause)) return;
      reportError(cause, "Unable to load feeds.");
    } finally {
      setTreeLoading(false);
    }
  });
  async function select(node: TreeNode) {
    props.focusPane("articles");
    const selection = selectionGuard.start();
    articleAbortController?.abort();
    const ids = sourceIds(node);
    if (!ids.length) {
      setArticles([]);
      void setArticleSelection(new Set<number>(), selection);
      setFocusedIndex(0);
      setSelectionAnchor(undefined);
      setSelectedNode(node);
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
      setFocusedIndex(0);
      setSelectionAnchor(nextArticles.length ? 0 : undefined);
      setSelectedNode(node);
      queueMicrotask(() =>
        document.querySelector<HTMLElement>(".article-list")?.focus(),
      );
    } catch (cause) {
      if (!selectionGuard.isCurrent(selection)) return;
      reportError(cause, "Could not load articles");
    } finally {
      if (selectionGuard.isCurrent(selection)) setArticlesLoading(false);
    }
  }
  function showProperties() {
    const node = selectedNode();
    if (!node) return;
    alert(
      node.type === "source"
        ? `Name: ${node.name}\nFeed URL: ${node.xmlUrl ?? ""}\nHome URL: ${node.homeUrl ?? ""}`
        : `Name: ${node.name}\nItems: ${node.children?.length ?? 0}`,
    );
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
        const content = extractReaderContent(
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

    // Fire the request first so network time overlaps with the local UI
    // work below instead of waiting for it; everything after this reads
    // as background work via .then/.catch, not a blocking await.
    const deletion = api("/articles", removedArticlesResponse, {
      body: JSON.stringify({ removedArticleIdList: ids }),
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });

    // Update the UI immediately; the delete request runs in the background
    // so removing a batch of articles doesn't block on a round trip.
    const { nextIndex, remaining } = removalOutcome(items, indexes);
    const nextArticle = remaining[nextIndex];
    setArticles(remaining);
    const openNext = setArticleSelection(
      new Set(nextArticle ? [nextIndex] : []),
    );
    openNext?.catch((cause) =>
      reportError(cause, "Could not refresh articles"),
    );
    setFocusedIndex(nextArticle ? nextIndex : 0);
    setSelectionAnchor(nextArticle ? nextIndex : undefined);

    // Every article in the list is unread by construction (the server only
    // returns unread articles), so removing one always frees exactly one
    // unread slot on its source. Update the tree count immediately instead
    // of waiting on a full tree refetch, then reconcile in the background.
    const deltas = new Map<string, number>();
    for (const index of indexes) {
      const sourceUid = items[index]!.sourceId.toString();
      deltas.set(sourceUid, (deltas.get(sourceUid) ?? 0) + 1);
    }
    setTree((current) => withDecrementedUnread(current, deltas));
    const current = selectedNode();
    if (current) {
      setSelectedNode(findNode(tree(), current.type, current.uid));
    }
    // The removed rows' DOM nodes are gone, which drops focus to
    // document.body; restore it to the list so keyboard nav keeps working.
    queueMicrotask(() =>
      document.querySelector<HTMLElement>(".article-list")?.focus(),
    );

    deletion
      .then(() =>
        loadTree().catch((cause) =>
          reportError(cause, "Could not refresh tree"),
        ),
      )
      .catch((cause) => {
        // The delete failed after the optimistic update already applied;
        // resync from the server instead of hand-reverting local state.
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
  function selectArticle(index: number, event?: MouseEvent | KeyboardEvent) {
    const next = transitionArticleSelection(
      selectedIndexes(),
      index,
      selectionAnchor(),
      event,
    );
    setFocusedIndex(index);
    setSelectionAnchor(next.anchor);
    void setArticleSelection(next.indexes);
  }
  function moveSelection(offset: number, event: KeyboardEvent) {
    if (!articles().length) return;
    event.preventDefault();
    const index =
      (focusedIndex() + offset + articles().length) % articles().length;
    selectArticle(index, event);
    document
      .querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
  function handleArticleKeys(event: KeyboardEvent) {
    if (event.key === "ArrowDown") moveSelection(1, event);
    else if (event.key === "ArrowUp") moveSelection(-1, event);
    else if (event.key === " ") {
      event.preventDefault();
      selectArticle(focusedIndex(), event);
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
    }
  }
  return (
    <main class="dashboard">
      <Show when={error()}>
        {(message) => (
          <p class="dashboard-alert" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={!showDiscovery() || !authenticated()}>
        <aside
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
              <img alt="" src={add} />
            </button>
            <button aria-label="add folder" onClick={() => void addNewFolder()}>
              <img alt="" src={addFolder} />
            </button>
            <button
              aria-label="source properties"
              disabled={!selectedNode()}
              onClick={showProperties}
            >
              <img alt="" src={details} />
            </button>
            <button
              aria-label="delete source"
              disabled={!selectedNode()}
              onClick={() => void removeSelectedNode()}
            >
              <img alt="" src={remove} />
            </button>
            <span />
            <button
              aria-label="options"
              class="only-mobile"
              onClick={() => props.navigate("/options")}
            >
              <img alt="" src={settings} />
            </button>
          </div>
          <Show
            when={!treeLoading()}
            fallback={
              <ul class="tree skeleton" aria-hidden="true">
                <For each={[...Array(50).keys()]}>
                  {() => (
                    <li>
                      <span class="skeleton-row" />
                    </li>
                  )}
                </For>
              </ul>
            }
          >
            <ul class="tree">
              <For each={tree()}>
                {(node) => (
                  <TreeItem
                    node={node}
                    select={(item) => void select(item)}
                    selected={selectedNode()}
                  />
                )}
              </For>
            </ul>
          </Show>
        </aside>
        <section
          class="dashboard-pane articles-pane"
          classList={{ "focused-pane": props.pane() === "articles" }}
        >
          <div class="toolbar">
            <button
              aria-label="back"
              class="only-mobile"
              onClick={props.backPane}
            >
              <img alt="" src={back} />
            </button>
            <button
              aria-label="select all"
              onClick={() =>
                void setArticleSelection(
                  new Set(articles().map((_, index) => index)),
                )
              }
            >
              <img alt="" src={selectAll} />
            </button>
            <button
              aria-label="delete articles"
              disabled={selectedIndexes().size === 0}
              onClick={() => removeSelected()}
            >
              <img alt="" src={remove} />
            </button>
            <span />
            <button
              aria-label="options"
              class="only-mobile"
              onClick={() => props.navigate("/options")}
            >
              <img alt="" src={settings} />
            </button>
          </div>
          <div
            class="article-list"
            role="listbox"
            tabIndex={0}
            onKeyDown={handleArticleKeys}
          >
            <Show
              when={!articlesLoading()}
              fallback={
                <div class="article-list skeleton" aria-hidden="true">
                  <For each={[...Array(30).keys()]}>
                    {() => (
                      <div class="article">
                        <span class="skeleton-row" style={{ width: "70%" }} />
                        <span class="skeleton-row" style={{ width: "40%" }} />
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
                      <div class="date-group">{article.group}</div>
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
                      aria-selected={selectedIndexes().has(index())}
                    >
                      <span class="title">{article.title}</span>
                      <span class="details">
                        <span>{article.author}</span>
                        <time>
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
          class="dashboard-pane reader-pane"
          classList={{ "focused-pane": props.pane() === "reader" }}
        >
          <div class="toolbar">
            <button
              aria-label="back"
              class="only-mobile"
              onClick={props.backPane}
            >
              <img alt="" src={back} />
            </button>
            <button
              aria-label="delete article"
              disabled={!selected()}
              onClick={() => removeSelected()}
            >
              <img alt="" src={remove} />
            </button>
            <span />
            <Show when={readerAvailable()}>
              <select
                value={displayMode()}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  const mode =
                    value === "READABILITY" || value === "READABILITY_PLAIN"
                      ? value
                      : "FEED";
                  setDisplayMode(mode);
                  if (selected()) void open(selected()!);
                }}
              >
                <option value="FEED">Feed</option>
                <option value="READABILITY">Reader</option>
                <option value="READABILITY_PLAIN">Reader plain</option>
              </select>
            </Show>
            <button
              aria-label="options"
              onClick={() => props.navigate("/options")}
            >
              <img alt="" src={settings} />
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
                    <p>
                      {selected()
                        ? "Reader content unavailable."
                        : "Select an article."}
                    </p>
                  }
                >
                  <span class="skeleton-row title" aria-hidden="true" />
                  <For each={READER_SKELETON_LINE_WIDTHS}>
                    {(width) => (
                      <span
                        class="skeleton-row"
                        style={{ width }}
                        aria-hidden="true"
                      />
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
          focusPane={props.focusPane}
          handleUnauthorized={props.handleUnauthorized}
          initialFeedUrl={props.initialFeedUrl}
          pane={props.pane}
          close={() => {
            setShowDiscovery(false);
            if (props.initialDiscovery) props.navigate("/");
          }}
          saved={async (sourceId) => {
            setShowDiscovery(false);
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
            // Subscribing only queues the feed fetch (the worker does the
            // actual network request), so the article list can still be
            // empty right after subscribing. Poll briefly rather than
            // leaving the user looking at a blank pane; bail out if they've
            // navigated elsewhere in the meantime.
            for (
              let attempt = 0;
              attempt < 5 &&
              articles().length === 0 &&
              selectedNode()?.uid === savedNode.uid;
              attempt++
            ) {
              // Deliberately sequential: each attempt waits out the delay,
              // then rechecks state before re-selecting -- not independent
              // work that Promise.all could parallelize.
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
