<script lang="ts">
import { browser } from "$app/environment";

import arrowDown from "$lib/images/arrow-down.png";

import arrowRight from "$lib/images/arrow-right.png";
import folder from "$lib/images/folder.png";
import folderOpened from "$lib/images/folder_opened.png";
import { onMount } from "svelte";
import type { TreeNodeComponentProps } from "../types.ts";
import { NodeType, type TreeNode } from "../types/source-types.ts";

import TreeNodeComponent from "./tree-node-component.svelte";

let isOpen = $state(false);

const {
  node,

  selectedNodeUid,

  nested,
  nodeSelected,
  nodeTouchStart,
  nodeHeld,
  nodeTouchEnd,

  nodeMouseLeave,
}: TreeNodeComponentProps = $props();

let pressTimer: number;
let longPressDetected = false;

onMount(() => {
  if (!browser || node.type !== NodeType.Folder) {
    return;
  }
  isOpen = JSON.parse(
    window.localStorage.getItem(`folderState:${node.uid}`) ?? "false",
  ) as boolean;
});

function handleNodeSelected(e: Event) {
  e.stopImmediatePropagation();
  e.preventDefault();
  if (longPressDetected) {
    return false;
  }
  nodeSelected(node);
  return true;
}


function toggleOpen(e: MouseEvent) {
  if (browser) {
    window.localStorage.setItem(
      `folderState:${node.uid}`,
      JSON.stringify(!isOpen),
    );
  }
  isOpen = !isOpen;

  e.stopImmediatePropagation();
  e.preventDefault();
  return false;
}


function getIcon(node: TreeNode) {
  if (node.type === NodeType.Folder) {
    return isOpen ? folderOpened : folder;
  }
  return `/favicons/${node.uid}`;
}


const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === "enter" || event.key === " ") {
    handleNodeSelected(event);
  }
};


function getUnreadCount(node: TreeNode): number {
  if (node.type === NodeType.Folder) {
    return node.children.reduce((prev: number, curr: TreeNode) => {
      return prev + getUnreadCount(curr);
    }, 0);
  }
  if ("unreadCount" in node) {
    return node.unreadCount;
  }
  return 0;
}


function hasUnread(node: TreeNode) {
  if (node.type === NodeType.Folder) {
    return node.children.some(
      (source) => source.type === NodeType.Source && source.unreadCount > 0,
    );
  }

  return node.unreadCount > 0;
}


function isNodeSelected(node: TreeNode, selectedNodeUid: string) {
  return node.type + node.uid === selectedNodeUid;
}


const onTouchStart = (e: Event) => {
  e.stopImmediatePropagation();
  longPressDetected = false;
  nodeTouchStart(node);
  pressTimer = window.setTimeout(() => {
    longPressDetected = true;
    nodeHeld(node);
  }, 1000);
};


const onTouchEnd = (e: Event) => {
  e.stopImmediatePropagation();
  nodeTouchEnd(node);
  clearTimeout(pressTimer);
  return false;
};
</script>

<div
  aria-selected={isNodeSelected(node, selectedNodeUid)}
  class="node {node.type}"
  class:nested
  class:open={isOpen && node.type === NodeType.Folder}
  class:selected={isNodeSelected(node, selectedNodeUid)}
  class:unread={hasUnread(node)}
  onclick={handleNodeSelected}
  onkeydown={handleKeyDown}
  onmousedown={onTouchStart}
  onmouseleave={() => { nodeMouseLeave(node); }}
  onmouseup={onTouchEnd}
  ontouchend={onTouchEnd}
  ontouchstart={onTouchStart}
  role="treeitem"
  tabindex="0"
>
  <div style="display: flex; align-items: center;">
    {#if node.type === NodeType.Folder}
      <button class="chevron" onclick={toggleOpen} aria-label="toggle folder">
        <img
          src={isOpen ? arrowDown : arrowRight}
          alt="toggle folder button"
        />
      </button>
    {/if}
    <img alt={node.name} class="node-icon" src={getIcon(node)} />
    <span>{node.name}</span>
  </div>
  {#if getUnreadCount(node) > 0}
    <span class="right">{getUnreadCount(node)}</span>
  {/if}
</div>
{#if node.type === NodeType.Folder && isOpen && Array.isArray(node.children)}
  {#each node.children as childNode (childNode.uid)}
    <TreeNodeComponent
      nested={true}
      node={childNode}
      {selectedNodeUid}
      {nodeSelected}
      {nodeHeld}
      {nodeTouchStart}
      {nodeTouchEnd}
      {nodeMouseLeave}
    />
  {/each}
{/if}

<style>
  * {
    user-select: none;
  }

  .node-icon {
    width: 1.5cap;
    height: 1.5cap;
    margin-right: 5px;
  }

  .node {
    width: 100%;
    font-size: 0.85rem;
    padding-left: 0.1rem;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
    line-height: 1.2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .chevron {
    background: none;
    color: inherit;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    outline: inherit;
    display: inline-block;
    margin: 0;
    flex: 0 0 1rem;
    width: 1rem;
    height: 1rem;
  }

  .source {
    padding-left: 1.4rem;
  }

  .nested {
    padding-left: 2rem;
  }

  .selected {
    color: var(--grey-10);
    background: var(--blue-40);
    border-bottom-color: var(--blue-40);
  }

  .unread {
    font-weight: bold;
  }

  .right {
    margin-left: auto;
    padding-left: 1rem;
    font-style: italic;
    margin-right: 0.5rem;
  }
</style>
