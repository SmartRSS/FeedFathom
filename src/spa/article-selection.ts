type SelectionModifiers = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function transitionArticleSelection(
  selectedIndexes: ReadonlySet<number>,
  index: number,
  selectionAnchor: number | undefined,
  modifiers: SelectionModifiers = {},
): { anchor: number; indexes: Set<number> } {
  const indexes = new Set(selectedIndexes);
  let anchor = selectionAnchor ?? index;

  if (modifiers.shiftKey) {
    if (!modifiers.ctrlKey) indexes.clear();
    for (
      let item = Math.min(anchor, index);
      item <= Math.max(anchor, index);
      item++
    )
      indexes.add(item);
  } else if (modifiers.ctrlKey || modifiers.metaKey) {
    indexes.has(index) ? indexes.delete(index) : indexes.add(index);
    anchor = index;
  } else {
    indexes.clear();
    indexes.add(index);
    anchor = index;
  }

  return { anchor, indexes };
}

export function removalOutcome<T>(
  items: readonly T[],
  indexes: ReadonlySet<number>,
): { nextIndex: number; remaining: T[] } {
  const remaining = items.filter((_, index) => !indexes.has(index));
  const nextIndex = Math.min(Math.min(...indexes), remaining.length - 1);
  return { nextIndex, remaining };
}

export function soleSelectedIndex(
  selectedIndexes: ReadonlySet<number>,
): number | undefined {
  if (selectedIndexes.size !== 1) return undefined;
  return selectedIndexes.values().next().value;
}
