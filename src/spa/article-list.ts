import { createSignal, type Accessor } from "solid-js";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { articlesRequest } from "#shared/contracts/requests.ts";
import { articlePageSize } from "#shared/contracts/limits.ts";
import type { ArticleSummary } from "#shared/contracts/responses.ts";
import { isEmptyFolder, type ListNode, type ListScope } from "./feed-tree.ts";

const articleFilter = articlesRequest.properties.filter;

export type ArticleFilter = Static<typeof articleFilter>;

export const isArticleFilter = (value: unknown): value is ArticleFilter =>
  Value.Check(articleFilter, value);

export type Cursor = Pick<ArticleSummary, "id" | "publishedAt">;

type PageRequest = (
  scope: ListScope,
  cursor: Cursor | undefined,
  signal: AbortSignal,
) => Promise<ArticleSummary[]>;

const maximumRestoredPages = 5;

export class ArticleList {
  readonly #request: PageRequest;
  readonly #rows = createSignal<ArticleSummary[]>([]);
  readonly #loading = createSignal(false);
  #controller = new AbortController();
  #scope: ListScope | undefined;
  #cursor: Cursor | undefined;
  #more = false;
  #loadingMore: AbortController | undefined;

  constructor(request: PageRequest) {
    this.#request = request;
  }

  readonly rows: Accessor<ArticleSummary[]> = () => this.#rows[0]();
  readonly loading: Accessor<boolean> = () => this.#loading[0]();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  setRows(rows: ArticleSummary[]): void {
    this.#rows[1](rows);
  }

  clear(): void {
    this.#start(undefined);
    this.#rows[1]([]);
    this.#loading[1](false);
  }

  async load(
    scope: ListScope,
    restoreRows = 0,
  ): Promise<ArticleSummary[] | undefined> {
    const { signal } = this.#start(scope);
    this.#loading[1](true);
    try {
      const wanted = Math.min(
        restoreRows,
        articlePageSize * maximumRestoredPages,
      );
      let page = await this.#request(scope, undefined, signal);
      const rows = [...page];
      while (
        rows.length < wanted &&
        page.length === articlePageSize &&
        !signal.aborted
      ) {
        // oxlint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's last row
        page = await this.#request(scope, rows.at(-1), signal);
        rows.push(...page);
      }
      if (signal.aborted) return undefined;
      this.#rows[1](rows);
      this.#more = page.length === articlePageSize;
      this.#cursor = rows.at(-1);
      return rows;
    } catch (cause) {
      if (signal.aborted) return undefined;
      throw cause;
    } finally {
      if (!signal.aborted) this.#loading[1](false);
    }
  }

  async loadMore(): Promise<number | undefined> {
    const scope = this.#scope;
    const cursor = this.#cursor;
    const controller = this.#controller;
    if (
      !scope ||
      !this.#more ||
      cursor === undefined ||
      this.#loadingMore === controller
    )
      return undefined;
    this.#loadingMore = controller;
    try {
      const page = await this.#request(scope, cursor, controller.signal);
      if (controller.signal.aborted) return undefined;
      this.#more = page.length === articlePageSize;
      this.#cursor = page.at(-1) ?? cursor;
      if (page.length) this.#rows[1]((rows) => [...rows, ...page]);
      return page.length;
    } catch (cause) {
      if (controller.signal.aborted) return undefined;
      throw cause;
    } finally {
      if (this.#loadingMore === controller) this.#loadingMore = undefined;
    }
  }

  #start(scope: ListScope | undefined): AbortController {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#scope = scope;
    this.#more = false;
    this.#cursor = undefined;
    return this.#controller;
  }
}

type EmptyListState =
  | "caughtUp"
  | "emptyFolder"
  | "failing"
  | "feedsFailed"
  | "noMatches"
  | "pickFeed";

export function emptyListState(state: {
  feedsFailed: boolean;
  loading: boolean;
  rows: number;
  searching: boolean;
  selected: ListNode | undefined;
  signedIn: boolean;
}): EmptyListState | undefined {
  if (state.loading || state.rows > 0) return undefined;
  if (state.searching) return "noMatches";
  const node = state.selected;
  if (node?.type === "source" && node.failing) return "failing";
  if (isEmptyFolder(node)) return "emptyFolder";
  if (node) return "caughtUp";
  if (state.signedIn) return "pickFeed";
  return state.feedsFailed ? "feedsFailed" : undefined;
}
