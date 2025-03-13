<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: bound by Svelte
import { goto } from "$app/navigation";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import back from "$lib/images/icons/Arrows/arrow-left-fill.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import doubleCheck from "$lib/images/icons/System/check-double-fill.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import del from "$lib/images/icons/System/delete-bin-7-fill.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import config from "$lib/images/icons/System/settings-5-fill.svg";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import type { ArticleListComponentProps } from "../types.ts";
import type { Article } from "../types/article-type.ts";
import { logError } from "../util/log.ts";

const {
  articlesSelected,
  selectedSourcesList,
  promisesMap,
  focusChanged,
  articlesRemoved,
  articlesLoaded,
  // biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
  focusedColumn,
}: ArticleListComponentProps = $props();

let selectedItems = $state(new SvelteSet<number>());
let lastSelectedIndex: number | null = $state(null);
let focusedIndex = $state(0);
// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
let isLoading = $state(false);
let articles: Article[] = $state([]);

let articlesListElement: HTMLElement | null;

async function fetchData() {
  try {
    if (selectedSourcesList.length === 0) {
      return;
    }

    articles = [];
    isLoading = true;
    const promise = promisesMap.get(selectedSourcesList.join(","));
    if (!promise) {
      return;
    }
    if (!articlesListElement) {
      return;
    }
    articlesListElement.scrollTop = 0;
    articles = await promise?.promise;
    const sourceArticleCounts = new Map<string, number>();
    for (const sourceId of selectedSourcesList) {
      sourceArticleCounts.set(sourceId, 0);
    }
    for (const article of articles) {
      const curr = sourceArticleCounts.get(String(article.sourceId));
      sourceArticleCounts.set(String(article.sourceId), curr ? curr + 1 : 1);
    }
    articlesLoaded(sourceArticleCounts);
    isLoading = false;
    if (articles.length === 0) {
      return;
    }
    lastSelectedIndex = 0;
    focusedIndex = 0;
    selectedItems.clear();
    selectedItems.add(0);
    articlesSelected(
      Array.from(selectedItems)
        .map((itemIndex) => articles[itemIndex]?.id)
        .filter((id) => typeof id === "number"),
    );
  } catch (e: unknown) {
    logError(e instanceof Error ? e.message : String(e));
    isLoading = false;
  }
}

onMount(fetchData);

function selectAll() {
  selectedItems = new SvelteSet(
    Array.from({ length: articles.length }, (_, i) => i),
  );
  articlesSelected(
    Array.from(selectedItems)
      .map((itemIndex) => articles[itemIndex]?.id)
      .filter((id) => typeof id === "number"),
  );
}

function handleCtrlA(event: KeyboardEvent) {
  event.preventDefault();
  if (!event.ctrlKey) {
    return;
  }
  selectAll();
}

function handleArrowDown(event: KeyboardEvent) {
  event.preventDefault();
  if (articles.length === 0) {
    return;
  }
  // highlight the next article, loop to start if needed
  focusedIndex = (focusedIndex + 1) % articles.length;
  if (selectedItems.size < 2 && !event.shiftKey && !event.ctrlKey) {
    selectedItems.clear();
    selectedItems.add(focusedIndex);
  }
  if (event.shiftKey) {
    selectedItems.add(focusedIndex);
  }
  document
    .querySelector(`[data-index="${focusedIndex}"]`)
    ?.scrollIntoView({ block: "nearest" });
  articlesSelected(
    Array.from(selectedItems)
      .map((itemIndex) => articles[itemIndex]?.id)
      .filter((id) => typeof id === "number"),
  );
}

function handleArrowUp(event: KeyboardEvent) {
  event.preventDefault();
  if (articles.length === 0) {
    return;
  }
  // highlight the previous article, loop to end if needed
  focusedIndex = (focusedIndex - 1 + articles.length) % articles.length;
  if (selectedItems.size < 2 && !event.shiftKey && !event.ctrlKey) {
    selectedItems.clear();
    selectedItems.add(focusedIndex);
  }
  if (event.shiftKey) {
    selectedItems.add(focusedIndex);
  }
  articlesSelected(
    Array.from(selectedItems)
      .map((itemIndex) => articles[itemIndex]?.id)
      .filter((id) => typeof id === "number"),
  );
}

function handleEnter(event: KeyboardEvent) {
  event.preventDefault();
  for (const index of selectedItems) {
    articles[index]?.url && window.open(articles[index].url, "_blank");
  }
}

function handleSpace(event: KeyboardEvent) {
  event.preventDefault();
  selectItem(focusedIndex, event);
}

function handleDelete(event: KeyboardEvent) {
  event.preventDefault();
  deleteItems();
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function handleKeyDown(event: KeyboardEvent) {
  switch (event.key) {
    case "a": {
      handleCtrlA(event);
      break;
    }
    case "ArrowDown": {
      handleArrowDown(event);
      break;
    }
    case "ArrowUp": {
      handleArrowUp(event);
      break;
    }
    case "Enter": {
      handleEnter(event);
      break;
    }
    case " ": {
      handleSpace(event);
      break;
    }
    case "Delete": {
      handleDelete(event);
      break;
    }
    default: {
      logError(`Unhandled key: ${event.key}`);
    }
  }
}

function deleteItems() {
  if (selectedItems.size === 0) {
    return;
  }
  void articlesRemoved(
    Array.from(selectedItems)
      .map((index) => articles[index])
      .filter(Boolean),
  );

  const numberOfArticles = Array.from(selectedItems).filter(
    (item) => item < focusedIndex,
  ).length;
  const maxIndex = focusedIndex - numberOfArticles;

  // Remove items from the array
  const filteredArticles = articles.filter(
    (_, index) => !selectedItems.has(index),
  );

  selectedItems.clear();

  // Clear selection and focus if no articles remain
  if (filteredArticles.length === 0) {
    articles = [];
    lastSelectedIndex = null;
    focusedIndex = 0;
    articlesSelected([]);
  } else {
    articles = [...filteredArticles];
    if (maxIndex >= filteredArticles.length) {
      focusedIndex = filteredArticles.length - 1;
    } else {
      focusedIndex -= numberOfArticles;
    }
    selectItem(focusedIndex);
  }

  articlesListElement?.focus();
}

function handleRangeSelection(index: number, startIndex: number) {
  const start = Math.min(index, startIndex);
  const end = Math.max(index, startIndex);
  for (let i = start; i <= end; i++) {
    selectedItems.add(i);
  }
}

function handleCtrlSelection(index: number) {
  if (selectedItems.has(index)) {
    selectedItems.delete(index);
  } else {
    selectedItems.add(index);
  }
}

function handleSingleSelection(index: number) {
  selectedItems.clear();
  selectedItems.add(index);
}

function selectItem(index: number, event?: MouseEvent | KeyboardEvent) {
  event?.preventDefault();
  focusedIndex = index;

  if (lastSelectedIndex === null) {
    handleSingleSelection(index);
  } else if (event?.ctrlKey && event?.shiftKey) {
    handleRangeSelection(index, lastSelectedIndex);
  } else if (event?.ctrlKey) {
    handleCtrlSelection(index);
  } else if (event?.shiftKey) {
    selectedItems.clear();
    handleRangeSelection(index, lastSelectedIndex);
  } else {
    handleSingleSelection(index);
  }

  lastSelectedIndex = index;

  articlesSelected(
    Array.from(selectedItems)
      .map((itemIndex) => articles[itemIndex]?.id)
      .filter((id) => typeof id === "number"),
  );

  focusChanged(".content-column");
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function handleBack() {
  focusChanged(".sources-column");
}

$effect(() => {
  selectedSourcesList;
  void fetchData();
});
$effect(() => {
  // selectedItems = selectedItems;
});
</script>

<div
  class="column-wrapper articles-column"
  class:focused-column={focusedColumn === ".articles-column"}
>
  <div class="toolbar">
    <button aria-label="back" class="only-mobile" onclick={handleBack}
      ><img alt="" src={back} /></button
    >
    <button aria-label="select all" onclick={selectAll}
      ><img alt="" src={doubleCheck} />
    </button>
    <button
      aria-label="remove article"
      disabled={selectedItems.size === 0}
      onclick={deleteItems}
      ><img alt="" src={del} />
    </button>
    <div class="spacer"></div>
    <button
      aria-label="options"
      class="settings-button only-mobile"
      onclick={async () => await goto("/options")}><img alt="" src={config} /></button
    >
  </div>
  <div
    bind:this={articlesListElement}
    class="articles-list"
    onkeydown={handleKeyDown}
    role="listbox"
    tabindex="0"
  >
    {#if isLoading}
      LOADING...
    {:else}
      {#each articles ?? [] as article, index (article)}
        {#if article.group !== articles[index - 1]?.group}
          <div class="date-group">{article.group}</div>
        {/if}
        <li
          class:selected={selectedItems.has(index)}
          class:active={focusedIndex === index}
          data-index={index}
        >
          <a
            href={article.url || `/readArticle/${article.id}`}
            onclick={(e) => selectItem(index, e)}
          >
            <div class="title">{article.title}</div>
            <div class="details">
              <div class="author">{article.author}</div>
              <div class="date">{article.publishedAt?.toLocaleString()}</div>
            </div>
          </a>
        </li>
      {/each}
    {/if}
  </div>
</div>

<style>
  li {
    line-height: 1rem;
    user-select: none;
    list-style: none;
    padding: 0.2rem 0.5rem;

    border-bottom: var(--border);
  }

  .active {
    border: var(--border);
    outline: 1px dotted var(--grey-50);
  }

  a {
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
  }

  .title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.8rem;
    flex-shrink: 1;
    flex-grow: 1;
    flex-basis: 100%;
  }

  .details {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: var(--grey-50);
    padding-top: 0.2rem;
  }

  .author {
    flex-shrink: 1;
    flex-grow: 1;
    flex-basis: 10px;
    white-space: nowrap;
    min-width: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .date {
    flex: 1;
    text-align: right;
  }

  .date-group {
    border-bottom: var(--border);
    background: linear-gradient(to bottom, var(--white) 3px, var(--grey-20));
    height: 1.5rem;
    line-height: 1.5rem;
    font-family: sans-serif;
    font-size: 0.75rem;
    text-align: center;
    font-weight: bold;
    -moz-user-select: none;
    user-select: none;
    position: sticky;
    top: 0;
  }

  .selected {
    color: var(--grey-10);
    background: var(--blue-40);
    border-bottom-color: var(--blue-40);
  }

  .articles-column {
    max-width: 40%;
  }

  .articles-list {
    overflow-y: auto; /* add scroll if content overflows */
    overflow-x: hidden;
    flex-grow: 1;
  }
</style>
