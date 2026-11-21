import {
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
  type Element,
} from "solid-js";
import { longPressHandlers } from "./context-menu.tsx";
import { classifyFetchFailure } from "#shared/util/fetch-failure.ts";
import {
  isSnoozedNode,
  treeNodeKey,
  unreadCount,
  type ListNode,
} from "./feed-tree.ts";
import { Icon } from "./icon.tsx";
import { storedPreference } from "./preferences.ts";
import feedRaw from "./assets/icons/System/rss-fill.svg?raw";
import mailRaw from "./assets/icons/System/mail-fill.svg?raw";
import alertRaw from "./assets/icons/System/alert-fill.svg?raw";
import arrowDownRaw from "./assets/icons/Arrows/chevron-down-fill.svg?raw";
import arrowRightRaw from "./assets/icons/Arrows/chevron-right-fill.svg?raw";
import folderRaw from "./assets/icons/Document/folder-fill.svg?raw";
import folderOpenedRaw from "./assets/icons/Document/folder-open-fill.svg?raw";

function moveTreeFocus(current: HTMLElement, offset: number) {
  const tree = current.closest('[role="tree"]');
  if (!tree) return;
  const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = items.indexOf(current);
  if (index === -1) return;
  const next = items[Math.min(items.length - 1, Math.max(0, index + offset))];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

export function ForEachNode(props: {
  children: (node: () => ListNode) => Element;
  each: ListNode[];
}) {
  const byKey = createMemo(
    () => new Map(props.each.map((node) => [treeNodeKey(node), node])),
  );
  return (
    <For each={[...byKey().keys()]}>
      {(key) => props.children(() => byKey().get(key)!)}
    </For>
  );
}

export function TreeItem(props: {
  isContext(key: string): boolean;
  isFocused(key: string): boolean;
  isSelected(key: string): boolean;
  node: ListNode;
  onContext(x: number, y: number, node: ListNode): void;
  onFocus(node: ListNode): void;
  select(node: ListNode): void;
}) {
  const nodeKey = () => treeNodeKey(props.node);
  const isSelected = () => props.isSelected(nodeKey());
  const longPress = longPressHandlers((x, y) =>
    props.onContext(x, y, props.node),
  );
  const folderState =
    untrack(() => props.node.type) === "folder"
      ? storedPreference(
          `folder:${untrack(() => props.node.uid)}`,
          ["open", "closed"],
          "open",
        )
      : undefined;
  const open = () => folderState?.get() === "open";
  const groupId = () => `tree-group-${props.node.uid}`;
  const [faviconLoaded, setFaviconLoaded] = createSignal(false);
  const [faviconFailed, setFaviconFailed] = createSignal(false);
  const isFolder = () => props.node.type === "folder";
  const children = () =>
    props.node.type === "folder" ? props.node.children : [];
  const unread = () => unreadCount(props.node);
  const snoozed = () => isSnoozedNode(props.node);
  const failing = () =>
    props.node.type === "source" ? (props.node.failing ?? null) : null;
  const favicon = () =>
    props.node.type === "source" ? props.node.favicon : null;
  function toggle() {
    folderState?.set(open() ? "closed" : "open");
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
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (event.currentTarget instanceof HTMLElement)
        moveTreeFocus(
          event.currentTarget,
          event.key === "Home" ? -Infinity : Infinity,
        );
    } else if (event.key === " " && isFolder()) {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
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
        aria-expanded={isFolder() ? (open() ? "true" : "false") : undefined}
        aria-owns={isFolder() && open() ? groupId() : undefined}
        aria-selected={isSelected() ? "true" : "false"}
        class={[
          "source",
          {
            "context-target": props.isContext(nodeKey()),
            folder: isFolder(),
            selected: isSelected(),
            unread: unread() > 0,
          },
        ]}
        data-tree-key={nodeKey()}
        onClick={() => props.select(props.node)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContext(event.clientX, event.clientY, props.node);
        }}
        onKeyDown={handleKeyDown}
        {...longPress}
        role="treeitem"
        tabindex={props.isFocused(nodeKey()) ? 0 : -1}
        onFocus={() => props.onFocus(props.node)}
      >
        <Show
          when={isFolder()}
          fallback={
            <Show
              when={favicon() && !faviconFailed()}
              fallback={
                <Icon
                  class="node-icon"
                  raw={
                    props.node.type === "source" && props.node.kind === "email"
                      ? mailRaw
                      : feedRaw
                  }
                />
              }
            >
              <img
                alt=""
                class={["node-icon", { "skeleton-row": !faviconLoaded() }]}
                decoding="async"
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
            class="folder-toggle"
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            <span
              class="chevron"
              innerHTML={open() ? arrowDownRaw : arrowRightRaw}
            />
            <span
              class="node-icon"
              innerHTML={open() ? folderOpenedRaw : folderRaw}
            />
          </span>
        </Show>
        <span class="source-name">{props.node.name}</span>
        <Show when={failing()}>
          {(state) => (
            <span
              class="source-failing"
              title={`Not updating. ${classifyFetchFailure(state().reason).sentence}`}
            >
              <Icon raw={alertRaw} />
              <span class="sr-only">Not updating</span>
            </span>
          )}
        </Show>
        <Show when={snoozed()}>
          <span
            class="snoozed-badge"
            title={
              props.node.type === "source" && props.node.pausedUntil
                ? `Snoozed until ${new Date(props.node.pausedUntil).toLocaleString()}`
                : "Snoozed"
            }
          >
            Snoozed
          </span>
        </Show>
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
          <ForEachNode each={children()}>
            {(child) => (
              <TreeItem
                isContext={props.isContext}
                isFocused={props.isFocused}
                isSelected={props.isSelected}
                node={child()}
                onContext={props.onContext}
                onFocus={props.onFocus}
                select={props.select}
              />
            )}
          </ForEachNode>
        </ul>
      </Show>
    </li>
  );
}
