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
import { BackButton, FeedDiscovery } from "./feed-discovery";
import { Icon } from "./icon";
import { resolvedTheme } from "./preferences";
// Inlined as raw markup (not <img src>) rather than a plain image import:
// every icon in this set is fill/stroke="currentColor" by design, so a
// row's icon automatically matches its own text color (grey by default,
// --selected-fg when selected, whatever the OS resolves it to under the
// auto theme's dark-mode-aware colors) with no per-case "is this
// background light or dark" guessing -- currentColor only resolves that
// way when the SVG is actually in the page's DOM, not loaded as an
// external image resource.
import addFolderRaw from "../lib/images/icons/Document/folder-add-fill.svg?raw";
import addRaw from "../lib/images/icons/System/add-box-fill.svg?raw";
import settingsRaw from "../lib/images/icons/System/settings-5-fill.svg?raw";
import detailsRaw from "../lib/images/icons/System/information-fill.svg?raw";
import removeRaw from "../lib/images/icons/System/delete-bin-7-fill.svg?raw";
import selectAllRaw from "../lib/images/icons/System/check-double-fill.svg?raw";
import feedRaw from "../lib/images/icons/System/rss-fill.svg?raw";
import arrowDownRaw from "../lib/images/icons/Arrows/chevron-down-fill.svg?raw";
import arrowRightRaw from "../lib/images/icons/Arrows/chevron-right-fill.svg?raw";
import folderRaw from "../lib/images/icons/Document/folder-fill.svg?raw";
import folderOpenedRaw from "../lib/images/icons/Document/folder-open-fill.svg?raw";

function ReaderBody(props: { content: ReaderContent }) {
  return props.content.kind === "html" ? (
    <div innerHTML={props.content.content} />
  ) : (
    <div class="reader-plain">{props.content.content}</div>
  );
}

function treeNodeKey(node: TreeNode): string {
  return `${node.type}:${node.uid}`;
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

// Only used for the very first tree render (see onMount): keeps the tree
// skeleton up until every favicon has settled (loaded or failed). A failed
// image still resolves via the .catch() below, so this can't hang on a
// broken favicon -- only on a request that never settles at all, which the
// browser's own network timeout bounds anyway.
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

// Folders are flat (one level, no nesting), so a source's containing
// folder is always a direct child lookup, never a deeper search.
function findParentFolderUid(
  nodes: TreeNode[],
  sourceUid: string,
): string | undefined {
  for (const node of nodes) {
    if (
      node.type === "folder" &&
      node.children.some(
        (child) => child.type === "source" && child.uid === sourceUid,
      )
    )
      return node.uid;
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

// Reads visible row order straight from the DOM instead of tracking it in
// state -- closed folders' children simply aren't rendered, so a plain
// query already reflects exactly what's visible, with no separate
// flattened-tree bookkeeping to keep in sync with each TreeItem's own
// open/closed signal.
function moveTreeFocus(current: HTMLElement, offset: number) {
  const items = [
    ...document.querySelectorAll<HTMLElement>(".sources-pane .source"),
  ];
  const index = items.indexOf(current);
  if (index === -1) return;
  const next = items[(index + offset + items.length) % items.length];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

function TreeItem(props: {
  focused: boolean;
  focusedKey: string | undefined;
  node: TreeNode;
  onFocus(node: TreeNode): void;
  select(node: TreeNode): void;
  selected: TreeNode | undefined;
}) {
  const [open, setOpen] = createSignal(storedFolderOpen(props.node.uid));
  const [faviconLoaded, setFaviconLoaded] = createSignal(false);
  const [faviconFailed, setFaviconFailed] = createSignal(false);
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
  function openFolder() {
    if (!open()) toggle();
  }
  function closeFolder() {
    if (open()) toggle();
  }
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.currentTarget instanceof HTMLElement)
        moveTreeFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === " " && isFolder()) {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      // Can't open further (it's a source, or an already-open folder) ->
      // fall back to the same action Enter takes: load its articles.
      if (isFolder() && !open()) openFolder();
      else props.select(props.node);
    } else if (event.key === "ArrowLeft" && isFolder()) {
      event.preventDefault();
      closeFolder();
    }
  }
  return (
    <li role="none">
      <button
        aria-expanded={isFolder() ? open() : undefined}
        aria-selected={props.selected === props.node}
        class="source"
        classList={{
          folder: isFolder(),
          selected: props.selected === props.node,
          unread: unread() > 0,
        }}
        data-tree-key={treeNodeKey(props.node)}
        onClick={() => props.select(props.node)}
        onKeyDown={handleKeyDown}
        role="treeitem"
        tabIndex={props.focused ? 0 : -1}
        onFocus={() => props.onFocus(props.node)}
      >
        <Show
          when={isFolder()}
          fallback={
            <Show
              when={favicon() && !faviconFailed()}
              fallback={<Icon class="node-icon" raw={feedRaw} />}
            >
              <img
                alt=""
                class="node-icon"
                classList={{ "skeleton-row": !faviconLoaded() }}
                src={favicon()!}
                onLoad={() => setFaviconLoaded(true)}
                onError={() => {
                  setFaviconLoaded(true);
                  setFaviconFailed(true);
                }}
              />
            </Show>
          }
        >
          <span
            aria-hidden="true"
            class="chevron"
            innerHTML={open() ? arrowDownRaw : arrowRightRaw}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          />
          <span
            aria-hidden="true"
            class="node-icon"
            innerHTML={open() ? folderOpenedRaw : folderRaw}
          />
        </Show>
        <span>{props.node.name}</span>
        <Show when={unread()}>{(count) => <em>{count()}</em>}</Show>
      </button>
      <Show when={isFolder() && open()}>
        <ul class="tree nested" role="group">
          <For each={children()}>
            {(child) => (
              <TreeItem
                focused={props.focusedKey === treeNodeKey(child)}
                focusedKey={props.focusedKey}
                node={child}
                onFocus={props.onFocus}
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
  const [editingSource, setEditingSource] =
    createSignal<Extract<TreeNode, { type: "source" }>>();
  // Roving tabindex for the tree: only the last-focused row is a Tab stop,
  // so Tab moves in and out of the whole tree instead of through every row.
  const [focusedTreeKey, setFocusedTreeKey] = createSignal<string>();
  // There's no way to detect whether a screen reader is actually running,
  // so this is always rendered (see the aria-live region below) -- it's
  // visually hidden either way, and only gets real text (and so only gets
  // announced) when high contrast mode happens to be off.
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
    treeAbortController?.abort();
    const controller = new AbortController();
    treeAbortController = controller;
    const attempt: Promise<TreeNode[]> = (async () => {
      try {
        return (await api("/tree", treeResponse, { signal: controller.signal }))
          .tree;
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
      // Land keyboard focus on the tree without calling select() -- that
      // would also kick off an articles load, which isn't wanted just from
      // landing on the page.
      queueMicrotask(() =>
        document.querySelector<HTMLElement>(".sources-pane .source")?.focus(),
      );
    }
    // Delayed, and only set (not already present at mount) so a screen
    // reader treats it as a live-region change and actually announces it,
    // rather than silently including it in the page's first read-through.
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
  function showProperties() {
    const node = selectedNode();
    if (!node) return;
    if (node.type === "source") {
      setEditingSource(node);
      props.focusPane("sources");
      setShowDiscovery(true);
      return;
    }
    alert(`Name: ${node.name}\nItems: ${node.children?.length ?? 0}`);
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
      // The deleted row's DOM node (and the now-disabled toolbar button) is
      // gone, dropping focus to document.body -- land it back on the tree
      // instead of leaving keyboard/screen-reader users stranded.
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
    const restoreIndex = nextArticle ? nextIndex : 0;
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
    queueMicrotask(() => focusArticleAt(restoreIndex));

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
  // Real DOM focus, same roving-tabindex mechanism as the tree: each row
  // carries its own tabindex (0 for the current one, -1 otherwise, see the
  // JSX below), so the browser announces the newly focused row on its own
  // -- no aria-activedescendant plumbing, no dependency on a screen
  // reader's support for it.
  function focusArticleAt(index: number) {
    setFocusedIndex(index);
    const element = document.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    );
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
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
  // Ctrl/Cmd held: move the focus cursor only, selection stays exactly as
  // it was -- Space is what commits a change at the new position. Without
  // the modifier, movement acts like a click: select just this row.
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
              onClick={showProperties}
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
            <ul class="tree" role="tree">
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
          class="dashboard-pane articles-pane"
          classList={{ "focused-pane": props.pane() === "articles" }}
        >
          <div class="toolbar">
            <BackButton backPane={props.backPane} />
            <button
              aria-label="select all"
              onClick={() => {
                // Clicking this button focuses it natively, same as any
                // button -- which sits outside .article-list, so its own
                // Delete/arrow-key handling (handleArticleKeys) never fires
                // afterward. Ctrl+A doesn't have this problem since it's
                // triggered from within the list already; this mirrors that
                // by moving focus back into the list right after selecting.
                void setArticleSelection(
                  new Set(articles().map((_, index) => index)),
                );
                if (articles().length) focusArticleAt(0);
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
                      tabIndex={focusedIndex() === index() ? 0 : -1}
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
            // Editing only renames/moves an already-subscribed feed --
            // there's nothing new to fetch, so skip the poll-for-articles
            // loop below, which exists only to wait out a fresh
            // subscription's initial (worker-driven) feed fetch.
            if (wasEditing) return;
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
