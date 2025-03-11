<script lang="ts">
import type { Article } from "../../../types/article-type.ts";
import type { PageData } from "./$types.ts";

export let data: PageData & { article: Article };
const { article } = data;
</script>

<svelte:head>
  <title>{article.title}</title>
</svelte:head>

<div class="article-container">
  <h1>{article.title}</h1>
  {#if article.author}
    <div class="author">By {article.author}</div>
  {/if}
  <div class="date">
    {article.publishedAt
      ? new Date(article.publishedAt).toLocaleDateString()
      : "No date"}
  </div>
  <div class="content">
    {@html article.content}
  </div>
</div>

<style>
  .article-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
  }

  h1 {
    margin-bottom: 1rem;
  }

  .author,
  .date {
    color: #666;
    margin-bottom: 0.5rem;
  }

  .content {
    margin-top: 2rem;
    line-height: 1.6;
  }

  .content :global(img) {
    max-width: 100%;
    height: auto;
  }

  .content :global(pre) {
    background: #f5f5f5;
    padding: 1rem;
    overflow-x: auto;
  }
</style>
