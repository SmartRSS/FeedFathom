<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: bound by Svelte
import { goto } from "$app/navigation";
import { DisplayMode } from "$lib/settings";
import { onDestroy, onMount } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: Svelte component
import ArticleComponent from "../components/article-component.svelte";
// biome-ignore lint/correctness/noUnusedImports: Svelte component
import ArticlesListComponent from "../components/article-list-component.svelte";
// biome-ignore lint/correctness/noUnusedImports: Svelte component
import TreeNodeComponent from "../components/tree-node-component.svelte";
import type {
  ArticlePromisesMap,
  ArticlesLoadedFunction,
  ArticlesRemovedFunction,
  ArticlesSelectedFunction,
  FocusChangedFunction,
  FocusTarget,
} from "../types.ts";
import type { Article } from "../types/article-type.ts";
import { NodeType, type TreeNode } from "../types/source-types.ts";

// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import addFolder from "../assets/add-folder.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import add from "../assets/add.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import config from "../assets/config.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import del from "../assets/del.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import properties from "../assets/properties.svg";

const staleTile = 5 * 1000;
const promisesMap: ArticlePromisesMap = new Map();

let selectedSourcesList: string[] = $state([]);
// biome-ignore lint/style/useConst: bound by Svelte
let sourceProperties: HTMLDialogElement | null = $state(null);
let selectedNode: TreeNode | null = $state(null);

let displayMode: DisplayMode = $state(DisplayMode.Feed);

let focusedColumn: FocusTarget = $state(".sources-column");

let currentNode: TreeNode | null = $state(null);
const { data } = $props();
let tree = $state(data.tree);

function handleBackButton() {
  if (!isMobile()) {
    return true;
  }
  if (focusedColumn === ".sources-column") {
    history.back();
    return true;
  }

  if (focusedColumn === ".articles-column") {
    setFocusTo(".sources-column");
    return;
  }
  setFocusTo(".articles-column");
  return;
}

const isMobile = () => {
  if (typeof window === "undefined") {
    return false; // Not in a browser environment
  }
  return window.matchMedia("only screen and (max-width: 768px)").matches;
};

onMount(() => {
  window.addEventListener("popstate", handleBackButton);
});

function setFocusTo(selector: FocusTarget) {
  if (focusedColumn !== ".content-column") {
    history.pushState({}, "", new URL(window.location.href));
  }
  focusedColumn = selector;
}

async function nodeSelected(node: TreeNode) {
  selectedSourcesList =
    node.type === NodeType.Folder
      ? node.children.map((child) => child.uid)
      : [node.uid];
  selectedNodeUid = node.type + node.uid;
  selectedArticleId = null;
  selectedNode = node;
  const articlesList = document.querySelector(".articles-list");
  if (articlesList instanceof HTMLElement) {
    articlesList.focus();
  }
  setFocusTo(".articles-column");
}

async function nodeHeld(node: TreeNode) {
  selectedSourcesList =
    node.type === "folder" && (node.children?.length ?? 0) > 0
      ? (node.children?.map((child) => child.uid) ?? [])
      : [node.uid];
  selectedNodeUid = node.type + node.uid;
  selectedNode = node;
}

let selectedArticleId: number | null = $state(null);
let selectedNodeUid: string = $state("");

const articlesSelected: ArticlesSelectedFunction = async (
  selectedArticleIdList,
) => {
  displayMode = DisplayMode.Feed;
  selectedArticleId =
    selectedArticleIdList.length === 1 && selectedArticleIdList[0]
      ? selectedArticleIdList[0]
      : null;
};

const focusChanged: FocusChangedFunction = (focusTarget) => {
  setFocusTo(focusTarget);
};

const articlesRemoved: ArticlesRemovedFunction = async (removedArticleList) => {
  if (removedArticleList.length > 0) {
    void fetch("./articles", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        removedArticleIdList: removedArticleList.map((article) => article.id),
      }),
    });
    const removedArticlesMap: Map<number, number> = removedArticleList.reduce(
      (map, article) => {
        const sourceId = article.sourceId;
        map.set(sourceId, (map.get(sourceId) ?? 0) + 1);
        return map;
      },
      new Map<number, number>(),
    );
    tree = tree.map((node) => {
      if (node.type === "folder") {
        node.children = node.children?.map((source) => {
          if (source.type === NodeType.Source) {
            const removedCount =
              removedArticlesMap.get(Number.parseInt(source.uid)) || 0;
            source.unreadCount = Math.max(
              0,
              (source.unreadCount || 0) - removedCount,
            );
          }
          return source;
        });
      }
      if (node.type === NodeType.Source) {
        const removedCount =
          removedArticlesMap.get(Number.parseInt(node.uid)) || 0;
        node.unreadCount = Math.max(0, (node.unreadCount || 0) - removedCount);
        return node;
      }
      return node;
    });
  }
};

$effect(() => {
  selectedNode;
  selectedNodeUid;
});

const handleSourceDetails = () => {
  sourceProperties?.showModal();
};

const handleDeleteSource = async () => {
  if (!selectedNode) {
    return;
  }
  if (!confirm("are ya sur?")) {
    return;
  }
  if (selectedNode.type === "folder") {
    if (selectedNode.children?.length > 0) {
      alert("folder has children");
      return;
    }
    void fetch("./folders", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        removeFolderId: Number.parseInt(
          selectedNode.uid.replace("folder", "`"),
        ),
      }),
    });
    return;
  }

  void fetch("./source", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      removeSourceId: Number.parseInt(selectedNode.uid.replace("source", "`")),
    }),
  });
};

function displayModeChanged(newDisplayMode: DisplayMode) {
  displayMode = newDisplayMode;
}

const articlesLoaded: ArticlesLoadedFunction = (sourcesArticlesMap) => {
  tree = tree.map((node) => {
    if (node.type === "folder") {
      node.children = node.children?.map((source) => {
        if (source.type === NodeType.Source) {
          source.unreadCount =
            sourcesArticlesMap.get(source.uid) ?? source.unreadCount;
        }
        return source;
      });
    }
    if (node.type === NodeType.Source) {
      node.unreadCount = sourcesArticlesMap.get(node.uid) ?? node.unreadCount;
    }
    return node;
  });
};

async function nodeTouchStart(node: TreeNode) {
  currentNode = node;
  const sources =
    node.type === NodeType.Folder
      ? node.children?.map((source: TreeNode) => source.uid).join(",")
      : node.uid;
  if (!sources) {
    return;
  }
  const date = Date.now();
  const currentPromise = promisesMap.get(sources);
  if (currentPromise && date < currentPromise.time + staleTile) {
    return;
  }
  promisesMap.set(sources, { time: date, promise: fetchArticles(sources) });
}

function nodeMouseLeave(node: TreeNode) {
  if (node.uid === currentNode?.uid && node.type === currentNode?.type) {
    currentNode = null;
  }
}

async function nodeTouchEnd(node: TreeNode) {
  if (node.uid !== currentNode?.uid || node.type !== currentNode?.type) {
    return;
  }
}

async function fetchArticles(sources: string) {
  const response = await fetch(`./articles?sources=${sources}`);
  return (await response.json()) as Promise<Article[]>;
}

const cleanupInterval = setInterval(clearStalePromises, staleTile / 2);
onDestroy(() => {
  promisesMap.clear();
  clearInterval(cleanupInterval);
  if (isMobile()) {
    window.removeEventListener("popstate", handleBackButton);
  }
});

function clearStalePromises() {
  const now = Date.now();
  for (const [uid, { time }] of promisesMap.entries()) {
    if (now - time > staleTile) {
      promisesMap.delete(uid);
    }
  }
}
</script>

<div class="container">
  <div
    class="column-wrapper sources-column"
    class:focused-column={focusedColumn === ".sources-column"}
  >
    <div class="toolbar">
      <button aria-label="add source" onclick={() => goto("/preview")}
        ><img alt="" src={add} />
      </button>
      <button aria-label="add folder" onclick={() => goto("/preview")}
        ><img alt="" src={addFolder} />
      </button>
      <button
        aria-label="source properties"
        disabled={selectedSourcesList.length !== 1}
        onclick={handleSourceDetails}
        ><img alt="" src={properties} />
      </button>
      <button
        aria-label="delete source"
        disabled={selectedSourcesList.length !== 1}
        onclick={handleDeleteSource}
        ><img alt="" src={del} />
      </button>
      <div class="spacer"></div>

      <button
        aria-label="options"
        class="settings-button only-mobile"
        onclick={() => goto("/options")}><img alt="" src={config} /></button
      >
    </div>
    <ul class="tree">
      {#each tree as node}
        <TreeNodeComponent
          {node}
          {selectedNodeUid}
          {nodeSelected}
          {nodeHeld}
          {nodeTouchStart}
          {nodeTouchEnd}
          {nodeMouseLeave}
          nested={false}
        />
      {/each}
    </ul>
  </div>
  <ArticlesListComponent
    {articlesLoaded}
    {articlesRemoved}
    {articlesSelected}
    {focusChanged}
    {focusedColumn}
    {promisesMap}
    {selectedSourcesList}
  ></ArticlesListComponent>
  <ArticleComponent
    {articlesRemoved}
    {displayMode}
    {displayModeChanged}
    {focusChanged}
    {focusedColumn}
    {selectedArticleId}
  ></ArticleComponent>
</div>
{#if selectedNode}
  <dialog bind:this={sourceProperties}>
    <div class="form-container">
      <form class="login-form">
        <div class="input-block">
          <label for="title">Title:</label>
          <input id="title" bind:value={selectedNode.name} />
        </div>
      </form>
    </div>
  </dialog>
{/if}

<style>
  .container {
    display: flex;
    gap: 0;
    max-width: 100%;
    max-height: 100%;
    flex-grow: 1;
    box-sizing: border-box;
  }

  .container > * {
    max-height: 100%;
    overflow-y: auto;
  }

  .sources-column {
    max-width: 40%;
  }

  .tree {
    padding-left: 0 !important;
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
    margin-top: 0;
    margin-bottom: 0;
    box-sizing: border-box;
    overflow-y: auto;
    flex-grow: 1;
  }
</style>
