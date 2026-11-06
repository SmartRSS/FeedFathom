import { createSignal, type Accessor } from "solid-js";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { articlesRequest } from "#shared/contracts/requests.ts";
import {
  articlePageSize,
  type ArticleSummary,
} from "#shared/contracts/responses.ts";
import { isEmptyFolder, type ListNode, type ListScope } from "./feed-tree.ts";

const articleFilter = articlesRequest.properties.filter;

export type ArticleFilter = Static<typeof articleFilter>;

export const isArticleFilter = (value: unknown): value is ArticleFilter =>
  Value.Check(articleFilter, value);

// The cursor is the last row of the last page received, not the last row
// still on screen. Deleting rows must not move it: deleting the whole page
// would leave no row to take a cursor from, which is exactly when the next
// page is most wanted. Its publishedAt places it in the offline list (#992)
// once it has left the kept rows.
export type Cursor = Pick<ArticleSummary, "id" | "publishedAt">;

type PageRequest = (
  scope: ListScope,
  cursor: Cursor | undefined,
  signal: AbortSignal,
) => Promise<ArticleSummary[]>;

// A restore pages as far as the list had been loaded, but never past five
// pages of a huge list.
const maximumRestoredPages = 5;

/** One article list: its rows and the pages behind them. Starting a new list
 *  abandons whatever the old one still has in flight, and its signal says
 *  whether work started for a list still belongs to the one on screen. */
export class ArticleList {
  readonly #request: PageRequest;
  readonly #rows = createSignal<ArticleSummary[]>([]);
  readonly #loading = createSignal(false);
  #controller = new AbortController();
  #scope: ListScope | undefined;
  #cursor: Cursor | undefined;
  // A full page means more articles may be available, not that another page
  // is guaranteed.
  #more = false;
  // The list whose next page is in flight. Tied to the list rather than a
  // plain flag, so a page abandoned by a feed, filter or search change
  // neither blocks the new list's next page nor, when it settles late,
  // clears that page's loading state.
  #loadingMore: AbortController | undefined;

  constructor(request: PageRequest) {
    this.#request = request;
  }

  readonly rows: Accessor<ArticleSummary[]> = () => this.#rows[0]();
  readonly loading: Accessor<boolean> = () => this.#loading[0]();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The rows as they are, for an optimistic change or its rollback. */
  setRows(rows: ArticleSummary[]): void {
    this.#rows[1](rows);
  }

  /** No list: nothing on screen and nothing in flight. */
  clear(): void {
    this.#start(undefined);
    this.#rows[1]([]);
    this.#loading[1](false);
  }

  /** A new list's first page, or as many pages as it takes to reach
   *  `restoreRows`. Undefined when another list superseded it. */
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

  /** The next page, appended. Resolves to how many rows arrived, or
   *  undefined when there was no page to ask for. */
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

/** What the articles pane says when it has no rows to show, if anything. */
export function emptyListState(state: {
  feedsFailed: boolean;
  loading: boolean;
  rows: number;
  searching: boolean;
  selected: ListNode | undefined;
  signedIn: boolean;
}): EmptyListState | undefined {
  if (state.loading || state.rows > 0) return undefined;
  // Search answers for every subscription, so an empty result is "no such
  // article", not "all caught up", and the prompt to pick a feed would be
  // wrong advice.
  if (state.searching) return "noMatches";
  const node = state.selected;
  if (node?.type === "source" && node.failing) return "failing";
  if (isEmptyFolder(node)) return "emptyFolder";
  if (node) return "caughtUp";
  if (state.signedIn) return "pickFeed";
  return state.feedsFailed ? "feedsFailed" : undefined;
}
