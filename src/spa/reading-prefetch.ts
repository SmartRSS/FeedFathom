import type { Article } from "#shared/contracts/responses.ts";
import { FINE_POINTER_QUERY } from "./panes.ts";
import { prefetchNext } from "./preferences.ts";

export function saveData(): boolean {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { connection } = navigator as { connection?: { saveData?: boolean } };
  return connection?.saveData === true;
}

export function neighbours<T>(
  items: readonly T[],
  index: number | undefined,
): T[] {
  if (index === undefined) return [];
  return [items[index + 1], items[index - 1]].filter(
    (item) => item !== undefined,
  );
}

type ArticleRequest = (id: number, signal: AbortSignal) => Promise<Article>;
type ArticleFetch = { controller: AbortController; request: Promise<Article> };

const hoverDelayMs = 150;

export class ArticleFetches {
  readonly #request: ArticleRequest;
  readonly #inFlight = new Map<number, ArticleFetch>();
  #press: AbortController | undefined;
  #hoverTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(request: ArticleRequest) {
    this.#request = request;
  }

  open(id: number): ArticleFetch {
    this.#press = undefined;
    return this.#fetch(id);
  }

  prefetch(id: number, openedId: number | undefined): void {
    if (!prefetchNext.get() || saveData() || openedId === id) return;
    this.#fetch(id);
  }

  prefetchAround(
    rows: readonly { id: number }[],
    index: number | undefined,
    openedId: number,
  ): void {
    const targets = neighbours(rows, index);
    if (!targets.length) return;
    const run = () => {
      for (const target of targets) this.prefetch(target.id, openedId);
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run);
    else setTimeout(run, 200);
  }

  press(event: PointerEvent, id: number, openedId: number | undefined): void {
    this.#press = undefined;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (saveData() || openedId === id || this.#inFlight.has(id)) return;
    this.#press = this.#fetch(id).controller;
  }

  cancelPress(): void {
    this.#press?.abort();
    this.#press = undefined;
  }

  hover(id: number, openedId: number | undefined): void {
    clearTimeout(this.#hoverTimer);
    if (!matchMedia(FINE_POINTER_QUERY).matches) return;
    this.#hoverTimer = setTimeout(
      () => this.prefetch(id, openedId),
      hoverDelayMs,
    );
  }

  leave(): void {
    clearTimeout(this.#hoverTimer);
  }

  #fetch(id: number): ArticleFetch {
    const existing = this.#inFlight.get(id);
    if (existing && !existing.controller.signal.aborted) return existing;
    const controller = new AbortController();
    const entry = { controller, request: this.#request(id, controller.signal) };
    this.#inFlight.set(id, entry);
    void entry.request
      .catch(() => {})
      .finally(() => {
        if (this.#inFlight.get(id) === entry) this.#inFlight.delete(id);
      });
    return entry;
  }
}
