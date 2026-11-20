import { createSignal, type Accessor } from "solid-js";
import type { AppSnapshot, ReadingSessionStore } from "./reading-session.ts";

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

export class SessionRestore {
  readonly store: ReadingSessionStore;
  readonly #restoring = createSignal(false);
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

  finish(): void {
    this.#passiveFirstPass = true;
    this.#setRestoring(false);
  }

  cancel(): void {
    if (!this.#active) return;
    this.#passiveFirstPass = false;
    this.#setRestoring(false);
  }

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

  takePassiveFirstPass(): boolean {
    const passive = this.#passiveFirstPass;
    this.#passiveFirstPass = false;
    return passive;
  }

  resumeReaderAt(articleId: number): void {
    this.#readerScrollId = articleId;
  }

  takeReaderScroll(articleId: number): number | undefined {
    const pending = this.#readerScrollId;
    this.#readerScrollId = undefined;
    return pending === articleId
      ? this.store.readerScroll(articleId)
      : undefined;
  }
}
