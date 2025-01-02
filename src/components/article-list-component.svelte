<script lang="ts">
  import { onMount } from "svelte";
  import type { Article } from "../types/article.type";
  import { goto } from "$app/navigation";
  import back from "$lib/images/icons/Arrows/arrow-left-fill.svg";
  import config from "$lib/images/icons/System/settings-5-fill.svg";
  import del from "$lib/images/icons/System/delete-bin-7-fill.svg";
  import doubleCheck from "$lib/images/icons/System/check-double-fill.svg";
  import type { ArticleListComponentProps } from "../types";
  import { SvelteSet as Set } from "svelte/reactivity";
  import { err } from "../util/log";

  let {
    articlesSelected,
    selectedSourcesList,
    promisesMap,
    focusChanged,
    articlesRemoved,
    articlesLoaded,
    focusedColumn,
  }: ArticleListComponentProps = $props();

  let selectedItems = $state(new Set<number>());
  let lastSelectedIndex: number | null = $state(null);
  let focusedIndex = $state(0);
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
      selectedSourcesList.forEach((sourceId) =>
        sourceArticleCounts.set(sourceId, 0),
      );
      articles.forEach((article) => {
        const curr = sourceArticleCounts.get(String(article.sourceId));
        sourceArticleCounts.set(String(article.sourceId), curr ? curr + 1 : 1);
      });
      articlesLoaded(sourceArticleCounts);
      isLoading = false;
      if (articles.length === 0) {
        return;
      }
      lastSelectedIndex = 0;
      focusedIndex = 0;
      selectedItems.clear();
      selectedItems.add(0);
      void articlesSelected(
        Array.from(selectedItems)
          .map((itemIndex) => articles[itemIndex]?.id)
          .filter((id) => typeof id === "number"),
      );
    } catch (e: any) {
      err(e.message);
      isLoading = false;
    }
  }

  onMount(fetchData);

  function selectAll() {
    selectedItems = new Set(
      Array.from({ length: articles.length }, (_, i) => i),
    );
    articlesSelected(
      Array.from(selectedItems)
        .map((itemIndex) => articles[itemIndex]?.id)
        .filter((id) => typeof id === "number"),
    );
  }

  function handleKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "a": {
        event.preventDefault();
        if (!event.ctrlKey) {
          return;
        }
        selectAll();

        break;
      }

      case "ArrowDown": {
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
        selectedItems = selectedItems;
        articlesSelected(
          Array.from(selectedItems)
            .map((itemIndex) => articles[itemIndex]?.id)
            .filter((id) => typeof id === "number"),
        );
        break;
      }
      case "ArrowUp": {
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
        selectedItems = selectedItems;
        articlesSelected(
          Array.from(selectedItems)
            .map((itemIndex) => articles[itemIndex]?.id)
            .filter((id) => typeof id === "number"),
        );
        break;
      }
      case "Enter": {
        event.preventDefault();
        for (const index of selectedItems) {
          articles[index]?.url && window.open(articles[index].url, "_blank");
        }
        break;
      }
      case " ": {
        event.preventDefault();
        selectItem(focusedIndex, event);
        break;
      }
      case "Delete": {
        event.preventDefault();
        deleteItems();
        break;
      }
    }
  }

  function deleteItems() {
    if (selectedItems.size === 0) {
      return;
    }
    articlesRemoved(
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
        focusedIndex = focusedIndex - numberOfArticles;
      }
      selectItem(focusedIndex);
    }

    articlesListElement?.focus();
  }

  function selectItem(index: number, event?: MouseEvent | KeyboardEvent) {
    event?.preventDefault();
    focusedIndex = index;
    if (event?.ctrlKey && event?.shiftKey) {
      if (lastSelectedIndex !== null) {
        const start = Math.min(index, lastSelectedIndex);
        const end = Math.max(index, lastSelectedIndex);
        for (let i = start; i <= end; i++) {
          selectedItems.add(i);
        }
      }
    } else if (event?.ctrlKey) {
      if (selectedItems.has(index)) {
        selectedItems.delete(index);
      } else {
        selectedItems.add(index);
      }
    } else if (event?.shiftKey) {
      if (lastSelectedIndex !== null) {
        selectedItems.clear();
        const start = Math.min(index, lastSelectedIndex);
        const end = Math.max(index, lastSelectedIndex);
        for (let i = start; i <= end; i++) {
          selectedItems.add(i);
        }
      }
    } else {
      selectedItems.clear();
      selectedItems.add(index);
    }
    lastSelectedIndex = index;

    articlesSelected(
      Array.from(selectedItems)
        .map((itemIndex) => articles[itemIndex]?.id)
        .filter((id) => typeof id === "number"),
    );

    focusChanged(".content-column");
  }

  function handleBack() {
    focusChanged(".sources-column");
  }

  $effect(() => {
    selectedSourcesList;
    fetchData();
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
      onclick={() => goto("/options")}><img alt="" src={config} /></button
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
