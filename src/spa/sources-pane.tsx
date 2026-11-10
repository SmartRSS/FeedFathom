import { createMemo, createSignal, For, Show } from "solid-js";
import type { TreeNode } from "#shared/contracts/responses.ts";
import type { failureDetails } from "./api.ts";
import { FailingFeedPanel } from "./failure-details.tsx";
import { treeNodeKey, treeTabStopKey, type ListNode } from "./feed-tree.ts";
import { Icon } from "./icon.tsx";
import { feedFilterBox } from "./preferences.ts";
import { ForEachNode, TreeItem } from "./tree-item.tsx";
import addFolderRaw from "./assets/icons/Document/folder-add-fill.svg?raw";
import addRaw from "./assets/icons/System/add-box-fill.svg?raw";
import editRaw from "./assets/icons/System/pencil-fill.svg?raw";
import removeRaw from "./assets/icons/System/delete-bin-7-fill.svg?raw";
import settingsRaw from "./assets/icons/System/settings-5-fill.svg?raw";

const TREE_SKELETON_NAMES = [
  "Example Feed Name",
  "A Longer Podcast Title",
  "Short Blog",
  "Weekly Newsletter Digest",
];

export type FeedsFailure = {
  details: ReturnType<typeof failureDetails>;
  message: string;
};

export function SourcesPane(props: {
  addSourceRef(element: HTMLButtonElement): void;
  admin: boolean;
  // The row an open context menu acts on, which need not be the selection.
  contextKey: string | undefined;
  // The selection the toolbar can edit or delete.
  editable: boolean;
  failure: FeedsFailure | undefined;
  filter: string;
  focused: boolean;
  loading: boolean;
  onAddFolder(): void;
  onAddSource(): void;
  onContext(x: number, y: number, node: ListNode): void;
  onDelete(): void;
  onFilter(filter: string): void;
  onImport(): void;
  onOptions(): void;
  onProperties(): void;
  onRetry(): void;
  onSelect(node: ListNode): void;
  propertiesRef(element: HTMLButtonElement): void;
  ref(element: HTMLElement): void;
  selected: ListNode | undefined;
  tree: TreeNode[];
  visibleTree: ListNode[];
}) {
  // Roving tabindex: only the last-focused row is a Tab stop, so Tab moves in
  // and out of the whole tree instead of through every row.
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const tabStop = createMemo(() =>
    treeTabStopKey(props.visibleTree, focusedKey()),
  );
  const failedWithNoTree = () =>
    props.failure && !props.tree.length ? props.failure : undefined;
  return (
    <aside
      aria-label="Feeds"
      class="dashboard-pane sources-pane"
      classList={{ "focused-pane": props.focused }}
      ref={props.ref}
    >
      <div class="toolbar">
        <button
          aria-label="add source"
          title="Add feed"
          ref={props.addSourceRef}
          onClick={() => props.onAddSource()}
        >
          <Icon raw={addRaw} />
          <span class="toolbar-label">Add feed</span>
        </button>
        <button
          aria-label="add folder"
          title="Add folder"
          onClick={() => props.onAddFolder()}
        >
          <Icon raw={addFolderRaw} />
          <span class="toolbar-label">Add folder</span>
        </button>
        <button
          aria-label="source properties"
          title="Edit"
          disabled={!props.editable}
          ref={props.propertiesRef}
          onClick={() => props.onProperties()}
        >
          <Icon raw={editRaw} />
          <span class="toolbar-label">Edit</span>
        </button>
        <button
          aria-label="delete source"
          title="Delete"
          disabled={!props.editable}
          onClick={() => props.onDelete()}
        >
          <Icon raw={removeRaw} />
          <span class="toolbar-label">Delete</span>
        </button>
        <span />
        <button
          aria-label="options"
          title="Options"
          class="only-mobile"
          onClick={() => props.onOptions()}
        >
          <Icon raw={settingsRaw} />
          <span class="toolbar-label">Options</span>
        </button>
      </div>
      <Show
        when={!props.loading}
        fallback={
          <>
            {/* The filter row the loaded tree will have, so nothing moves
                when it arrives. */}
            <Show when={feedFilterBox.get()}>
              <input
                aria-label="Filter feeds"
                class="tree-filter"
                disabled
                placeholder="Filter feeds"
                type="search"
              />
            </Show>
            <ul class="tree skeleton" aria-hidden="true">
              <For each={[...Array(50).keys()]}>
                {(index) => (
                  <li>
                    <div class="source">
                      <span class="node-icon skeleton-row" />
                      <span class="skeleton-text">
                        {
                          TREE_SKELETON_NAMES[
                            index % TREE_SKELETON_NAMES.length
                          ]
                        }
                      </span>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </>
        }
      >
        {/* First-run guidance (#723): only ever visible while the tree is
            empty, so it dismisses itself the moment a source exists. */}
        <Show
          when={props.tree.length > 0 || props.failure}
          fallback={
            <div class="tree-empty">
              <p class="tree-empty-heading">No feeds yet.</p>
              <button type="button" onClick={() => props.onAddSource()}>
                Add your first feed
              </button>
              <p>
                Moving from another reader?{" "}
                <a
                  href="/options#import-opml"
                  onClick={(event) => {
                    event.preventDefault();
                    props.onImport();
                  }}
                >
                  Import an OPML file
                </a>
                .
              </p>
            </div>
          }
        >
          <Show when={feedFilterBox.get()}>
            <input
              aria-label="Filter feeds"
              class="tree-filter"
              disabled={Boolean(failedWithNoTree())}
              placeholder="Filter feeds"
              type="search"
              value={props.filter}
              onInput={(event) => props.onFilter(event.currentTarget.value)}
            />
          </Show>
          <Show when={failedWithNoTree()}>
            {(failure) => (
              <FailingFeedPanel
                admin={props.admin}
                details={failure().details}
                layout="block"
                role="alert"
                onRetry={props.onRetry}
              >
                <p>{failure().message}</p>
              </FailingFeedPanel>
            )}
          </Show>
          <Show
            when={
              !props.failure && props.filter.trim() && !props.visibleTree.length
            }
          >
            <div class="article-list-empty" role="status">
              <p>No feeds match that.</p>
            </div>
          </Show>
          <ul aria-label="Feeds" class="tree" role="tree">
            <ForEachNode each={props.visibleTree}>
              {(node) => (
                <TreeItem
                  contextKey={props.contextKey}
                  focused={tabStop() === treeNodeKey(node())}
                  onContext={props.onContext}
                  focusedKey={tabStop()}
                  node={node()}
                  onFocus={(item) => setFocusedKey(treeNodeKey(item))}
                  select={props.onSelect}
                  selected={props.selected}
                />
              )}
            </ForEachNode>
          </ul>
        </Show>
      </Show>
    </aside>
  );
}
