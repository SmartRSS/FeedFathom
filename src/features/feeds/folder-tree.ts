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
