import { createSignal, For, Show } from "solid-js";
import type { TreeNode } from "#shared/contracts/responses.ts";
import {
  folderOpenFromStored,
  folderOpenStorageKey,
  folderOpenToStored,
  treeNodeKey,
  unreadCount,
} from "./dashboard-behavior.ts";
import { Icon } from "./icon.tsx";
import feedRaw from "./assets/icons/System/rss-fill.svg?raw";
import arrowDownRaw from "./assets/icons/Arrows/chevron-down-fill.svg?raw";
import arrowRightRaw from "./assets/icons/Arrows/chevron-right-fill.svg?raw";
import folderRaw from "./assets/icons/Document/folder-fill.svg?raw";
import folderOpenedRaw from "./assets/icons/Document/folder-open-fill.svg?raw";

// localStorage throws in a private-browsing context and when the origin has
// no storage access; a folder falling back to open is the safe outcome.
function storedFolderOpen(uid: string) {
  try {
    return folderOpenFromStored(
      localStorage.getItem(folderOpenStorageKey(uid)),
    );
  } catch {
    return true;
  }
}

function storeFolderOpen(uid: string, open: boolean) {
  try {
    localStorage.setItem(folderOpenStorageKey(uid), folderOpenToStored(open));
  } catch {}
}

// Reads visible row order straight from the DOM instead of tracking it in
// state -- closed folders' children simply aren't rendered, so a plain
// query already reflects exactly what's visible, with no separate
// flattened-tree bookkeeping to keep in sync with each TreeItem's own
// open/closed signal.
function moveTreeFocus(current: HTMLElement, offset: number) {
  const items = [
    ...document.querySelectorAll<HTMLElement>(".sources-pane .source"),
  ];
  const index = items.indexOf(current);
  if (index === -1) return;
  const next = items[(index + offset + items.length) % items.length];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

export function TreeItem(props: {
  focused: boolean;
  focusedKey: string | undefined;
  node: TreeNode;
  onFocus(node: TreeNode): void;
  select(node: TreeNode): void;
  selected: TreeNode | undefined;
}) {
  const [open, setOpen] = createSignal(storedFolderOpen(props.node.uid));
  // The nested <ul role="group"> below is a DOM *sibling* of this row's
  // treeitem (a button can't contain a list), and the presentational <li>
  // around them both re-parents it onto the tree root -- leaving the group
  // beside the folder rather than under it, with aria-expanded pointing at
  // nothing. aria-owns puts it back where it belongs without restructuring
  // the row into a non-button element, which would cost the button's native
  // Enter/Space activation that handleKeyDown deliberately doesn't handle.
  const groupId = () => `tree-group-${props.node.uid}`;
  const [faviconLoaded, setFaviconLoaded] = createSignal(false);
  const [faviconFailed, setFaviconFailed] = createSignal(false);
  const isFolder = () => props.node.type === "folder";
  const children = () =>
    props.node.type === "folder" ? props.node.children : [];
  const unread = () => unreadCount(props.node);
  const favicon = () =>
    props.node.type === "source" ? props.node.favicon : null;
  function toggle() {
    const next = !open();
    setOpen(next);
    storeFolderOpen(props.node.uid, next);
  }
  function openFolder() {
    if (!open()) toggle();
  }
  function closeFolder() {
    if (open()) toggle();
  }
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.currentTarget instanceof HTMLElement)
        moveTreeFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === " " && isFolder()) {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      // Can't open further (it's a source, or an already-open folder) ->
      // fall back to the same action Enter takes: load its articles.
      if (isFolder() && !open()) openFolder();
      else props.select(props.node);
    } else if (event.key === "ArrowLeft" && isFolder()) {
      event.preventDefault();
      closeFolder();
    }
  }
  return (
    <li role="none">
      <button
        aria-expanded={isFolder() ? open() : undefined}
        aria-owns={isFolder() && open() ? groupId() : undefined}
        aria-selected={props.selected === props.node}
        class="source"
        classList={{
          folder: isFolder(),
          selected: props.selected === props.node,
          unread: unread() > 0,
        }}
        data-tree-key={treeNodeKey(props.node)}
        onClick={() => props.select(props.node)}
        onKeyDown={handleKeyDown}
        role="treeitem"
        tabIndex={props.focused ? 0 : -1}
        onFocus={() => props.onFocus(props.node)}
      >
        <Show
          when={isFolder()}
          fallback={
            <Show
              when={favicon() && !faviconFailed()}
              fallback={<Icon class="node-icon" raw={feedRaw} />}
            >
              <img
                alt=""
                class="node-icon"
                classList={{ "skeleton-row": !faviconLoaded() }}
                src={favicon()!}
                onLoad={() => setFaviconLoaded(true)}
                onError={() => {
                  setFaviconLoaded(true);
                  setFaviconFailed(true);
                }}
              />
            </Show>
          }
        >
          <span
            aria-hidden="true"
            class="chevron"
            innerHTML={open() ? arrowDownRaw : arrowRightRaw}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          />
          <span
            aria-hidden="true"
            class="node-icon"
            innerHTML={open() ? folderOpenedRaw : folderRaw}
          />
        </Show>
        <span>{props.node.name}</span>
        <Show when={unread()}>
          {(count) => (
            <span aria-label={`${count()} unread`} class="unread-count">
              {count()}
            </span>
          )}
        </Show>
      </button>
      <Show when={isFolder() && open()}>
        <ul class="tree nested" id={groupId()} role="group">
          <For each={children()}>
            {(child) => (
              <TreeItem
                focused={props.focusedKey === treeNodeKey(child)}
                focusedKey={props.focusedKey}
                node={child}
                onFocus={props.onFocus}
                select={props.select}
                selected={props.selected}
              />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}
