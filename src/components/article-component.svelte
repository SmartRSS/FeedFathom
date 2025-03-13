<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: bound by Svelte
import { goto } from "$app/navigation";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import back from "$lib/images/icons/Arrows/arrow-left-fill.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import del from "$lib/images/icons/System/delete-bin-7-fill.svg";
// biome-ignore lint/correctness/noUnusedImports: Svelte asset
import config from "$lib/images/icons/System/settings-5-fill.svg";
import type { DisplayMode } from "$lib/settings";
import { onDestroy, onMount } from "svelte";
import type {
  ArticlesRemovedFunction,
  DisplayModeChangedFunction,
  FocusChangedFunction,
  FocusTarget,
} from "../types.ts";
import type { Article } from "../types/article-type.ts";
import { logError } from "../util/log.ts";

type ArticleComponentProps = {
  selectedArticleId: number | null;
  displayMode: DisplayMode;
  articlesRemoved: ArticlesRemovedFunction;
  focusChanged: FocusChangedFunction;
  displayModeChanged: DisplayModeChangedFunction;
  focusedColumn: FocusTarget;
};
// biome-ignore lint/style/useConst: bound by Svelte
let {
  selectedArticleId,
  displayMode,
  articlesRemoved,
  focusChanged,
  displayModeChanged,
  // biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
  focusedColumn,
}: ArticleComponentProps = $props();

let selectedArticle: Article;
let frame: HTMLIFrameElement;

const clickHandler = (event: MouseEvent) => {
  const targetElement = event.target as HTMLElement;
  if (targetElement.matches("a")) {
    const href = targetElement.getAttribute("href");
    if (!href?.startsWith("#")) {
      return true;
    }
    const name = href.substring(1);

    const element =
      frame?.contentDocument?.querySelector(`[name="${name}"]`) ??
      frame?.contentDocument?.getElementById(name);

    if (!element) {
      return true;
    }
    event.preventDefault();
    const getOffset = (el: Element) => {
      const box = el.getBoundingClientRect();

      return {
        top:
          box.top +
          (frame?.contentWindow?.scrollY ?? 0) -
          (frame?.contentDocument?.documentElement.clientTop ?? 0),
        left:
          box.left +
          (frame?.contentWindow?.scrollX ?? 0) -
          (frame?.contentDocument?.documentElement.clientLeft ?? 0),
      };
    };

    const offset = getOffset(element);
    frame?.contentWindow?.scrollTo(offset.left, offset.top);
    return false;
  }
  return true;
};
onMount(() => {
  void fetchData();
  if (frame?.contentDocument?.body) {
    frame.contentDocument.body.addEventListener("click", clickHandler);
  }
});

onDestroy(() => {
  if (frame?.contentDocument?.body) {
    frame.contentDocument.body.removeEventListener("click", clickHandler);
  }
});

async function fetchData(attempt = 0) {
  if (attempt > 10) {
    logError("failed to fetch data");
    return;
  }

  if (!frame) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fetchData(attempt + 1);
    return;
  }
  const iframeDoc = frame?.contentDocument ?? frame?.contentWindow?.document;
  if (!iframeDoc) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fetchData(attempt + 1);
    return;
  }

  iframeDoc.head.innerHTML = "";
  const styleEl = iframeDoc.createElement("style");
  styleEl.innerHTML = `
            body {
                height: initial;
                max-height: initial;
                width: initial;
                max-width: initial;
                color: initial;
                background-color: initial;
                overflow: initial;
                display: block;
                min-width: initial;
                min-height: initial;
                padding: 20px 30px;
                margin: 0;
                font-family: Arial, sans-serif;
                font-size: 0.9rem;
                line-height: 1.5;
                word-wrap: break-word;
                white-space: pre-line;
            }
            body * {
                max-width: 100% !important;
                height: auto !important;
                width: auto;
                word-wrap: break-word;
            }
        `;
  iframeDoc.head.append(styleEl);
  if (!selectedArticleId) {
    iframeDoc.body.innerHTML = "";

    return;
  }
  iframeDoc.body.innerHTML = "Loading...";

  try {
    const res = await fetch(
      `/article?article=${selectedArticleId}&displayMode=${displayMode}`,
    );
    selectedArticle = (await res.json()) as Article;
    if (typeof selectedArticle.content !== "string") {
      return;
    }

    iframeDoc.body.removeEventListener("click", clickHandler);
    iframeDoc.body.addEventListener("click", clickHandler);
    iframeDoc.body.innerHTML = selectedArticle.content;
  } catch (error) {
    logError("Error fetching data", error);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function handleBack() {
  focusChanged(".articles-column");
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function deleteItem() {
  void articlesRemoved([selectedArticle]);
}

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function handleChange() {
  displayModeChanged(displayMode);
}

$effect(() => {
  void fetchData();
});

// biome-ignore lint/correctness/noUnusedVariables: bound by Svelte
function shouldHide() {
  return (
    typeof window !== "undefined" &&
    window.location &&
    window?.location.pathname.startsWith("/readArticle")
  );
}
</script>

<div
  class="column-wrapper content-column"
  class:focused-column={focusedColumn === ".content-column"}
>
  <div class="toolbar">
    <button
      aria-label="back"
      class="only-mobile {shouldHide() ? 'hide' : ''}"
      onclick={handleBack}><img alt="" src={back} /></button
    >
    <button
      aria-label="delete article"
      class={shouldHide() ? "hide" : ""}
      onclick={deleteItem}><img alt="" src={del} /></button
    >
    <div class="spacer"></div>
    <select bind:value={displayMode} onchange={handleChange}>
      <option value="FEED">feed</option>
      <option value="READABILITY">readability</option>
      <option value="READABILITY_PLAIN">readability plain</option>
    </select>
    <button
      aria-label="options"
      class="settings-button"
      onclick={async () => await goto("/options")}><img alt="" src={config} /></button
    >
  </div>
  <iframe bind:this={frame} title="article content"></iframe>
</div>

<style>
  .content-column {
    height: 100%;
    min-height: 100%;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }

  .hide {
    display: none !important;
  }
</style>
