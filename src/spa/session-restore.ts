import { createSignal, type Accessor } from "solid-js";
import type { AppSnapshot, ReadingSessionStore } from "./reading-session.ts";

// Session restoration (#718) at boot: the list, selection and scroll
// positions the tab left with.

/** Where a restored list puts its selection, by row index, or undefined when
 *  none of the snapshot's rows came back: the normal boot path then applies. */
export function restoredSelection(
  rows: readonly { id: number }[],
  snapshot: AppSnapshot,
): { anchor: number; focus: number; indexes: number[] } | undefined {
  const indexOf = new Map(rows.map((row, index) => [row.id, index]));
  const at = (id: number | undefined) =>
    id === undefined ? undefined : indexOf.get(id);
  let ids = snapshot.selectedIds ?? [];
  if (!ids.length && snapshot.articleId !== undefined)
    ids = [snapshot.articleId];
  const indexes = ids.flatMap((id) => at(id) ?? []);
  if (!indexes.length) return undefined;
  const first = Math.min(...indexes);
  return {
    anchor: at(snapshot.anchorId) ?? first,
    focus: at(snapshot.focusedId) ?? first,
    indexes,
  };
}

/** The restore in progress. While `restoring()` holds, nothing records over
 *  the snapshot and the scroll-past observer stays off, so the programmatic
 *  scroll that applies it never reads as the user scrolling past rows. */
export class SessionRestore {
  readonly store: ReadingSessionStore;
  readonly #restoring = createSignal(false);
  // The same state for the synchronous checks here: a write to the signal
  // shows in its reads only after Solid's next flush, and select() cancels
  // then records in one go.
  #active = false;
  #passiveFirstPass = false;
  #readerScrollId: number | undefined;

  constructor(store: ReadingSessionStore) {
    this.store = store;
  }

  readonly restoring: Accessor<boolean> = () => this.#restoring[0]();

  begin(): void {
    this.#passiveFirstPass = true;
    this.#setRestoring(true);
  }

  /** The stored scroll is applied. The rows on screen at that position got
   *  there programmatically, so the observer's first pass only takes note:
   *  they become eligible once they leave and re-enter the viewport. */
  finish(): void {
    this.#passiveFirstPass = true;
    this.#setRestoring(false);
  }

  /** Something else took over, such as a feed picked from the cached tree
   *  (#989), and is recorded in the snapshot's place. */
  cancel(): void {
    if (!this.#active) return;
    this.#passiveFirstPass = false;
    this.#setRestoring(false);
  }

  /** The snapshot cannot apply. Dropping it keeps the next boot from trying
   *  it again. */
  abandon(): void {
    this.store.clear();
    this.#setRestoring(false);
  }

  record(patch: Partial<AppSnapshot>): void {
    if (!this.#active) this.store.recordApp(patch);
  }

  #setRestoring(active: boolean): void {
    this.#active = active;
    this.#restoring[1](active);
  }

  /** True once after finish(): whether the next observer's first pass only
   *  takes note. */
  takePassiveFirstPass(): boolean {
    const passive = this.#passiveFirstPass;
    this.#passiveFirstPass = false;
    return passive;
  }

  resumeReaderAt(articleId: number): void {
    this.#readerScrollId = articleId;
  }

  /** The stored reader ratio when `articleId` is the article the restore
   *  opened. The first article to render spends it either way. */
  takeReaderScroll(articleId: number): number | undefined {
    const pending = this.#readerScrollId;
    this.#readerScrollId = undefined;
    return pending === articleId
      ? this.store.readerScroll(articleId)
      : undefined;
  }
}
