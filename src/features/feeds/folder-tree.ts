/**
 * Splits a user's subscriptions into those filed under a folder, keyed by the
 * folder's id, and those at the root. The tree route and the OPML export
 * build their nested shapes from this; each maps a source to its own item.
 */
export function groupByFolder<Source extends { parentId: null | number }, Item>(
  sources: readonly Source[],
  toItem: (source: Source) => Item,
): { children: Map<number, Item[]>; roots: Item[] } {
  const children = new Map<number, Item[]>();
  const roots: Item[] = [];
  for (const source of sources) {
    const item = toItem(source);
    if (source.parentId === null) roots.push(item);
    else {
      const siblings = children.get(source.parentId);
      if (siblings) siblings.push(item);
      else children.set(source.parentId, [item]);
    }
  }
  return { children, roots };
}
