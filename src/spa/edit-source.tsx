import { createSignal, For, onMount, Show } from "solid-js";
import { api } from "./api";
import {
  foldersResponse,
  updatedSourceResponse,
  type Folder,
  type TreeNode,
} from "../contracts/responses";

type SourceNode = Extract<TreeNode, { type: "source" }>;

export function EditSourceDialog(props: {
  handleUnauthorized(cause: unknown): boolean;
  node: SourceNode;
  onClose(): void;
  onSaved(): void;
  parentUid: string | undefined;
}) {
  let dialogRef!: HTMLDialogElement;
  const [name, setName] = createSignal(props.node.name);
  const [folderId, setFolderId] = createSignal(props.parentUid ?? "");
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [foldersLoaded, setFoldersLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");

  onMount(async () => {
    dialogRef.showModal();
    try {
      setFolders(await api("/folders", foldersResponse));
    } catch (cause) {
      if (!props.handleUnauthorized(cause))
        setMessage(
          cause instanceof Error ? cause.message : "Could not load folders.",
        );
    } finally {
      setFoldersLoaded(true);
    }
  });

  async function save(event: Event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await api("/source", updatedSourceResponse, {
        body: JSON.stringify({
          sourceFolder: folderId() ? Number(folderId()) : null,
          sourceId: Number(props.node.uid),
          sourceName: name(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      dialogRef.close();
      props.onSaved();
    } catch (cause) {
      if (!props.handleUnauthorized(cause))
        setMessage(
          cause instanceof Error ? cause.message : "Could not save changes.",
        );
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog class="edit-source-dialog" ref={dialogRef} onClose={props.onClose}>
      <form onSubmit={save}>
        <h2>Edit source</h2>
        <label>
          Title
          <input
            required
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          Folder
          {/* Deferred until folders() loads: assigning `value` before its
              matching <option> exists (the folder list arrives async) has
              nothing to select against yet, and Solid doesn't re-apply the
              value binding just because sibling <option>s changed later --
              it would silently fall back to whatever the browser defaults
              to (the first option) instead of the real current folder. */}
          <Show
            when={foldersLoaded()}
            fallback={
              <select disabled>
                <option>Loading…</option>
              </select>
            }
          >
            <select
              value={folderId()}
              onChange={(event) => setFolderId(event.currentTarget.value)}
            >
              <option value="">No parent</option>
              <For each={folders()}>
                {(item) => <option value={item.id}>{item.name}</option>}
              </For>
            </select>
          </Show>
        </label>
        {/* Feed/home URL live on the shared `sources` row (see
            sources_url_unique) -- every other subscriber to this same feed
            points at the same row, so editing them here would silently
            repoint everyone else's subscription too. Unsubscribing and
            subscribing to a different URL is the safe way to do that. */}
        <label>
          Feed URL
          <input
            disabled
            title="Shared with every subscriber to this feed"
            value={props.node.xmlUrl}
          />
        </label>
        <label>
          Home URL
          <input
            disabled
            title="Shared with every subscriber to this feed"
            value={props.node.homeUrl}
          />
        </label>
        <Show when={message()}>{(text) => <p role="alert">{text()}</p>}</Show>
        <div class="form-actions">
          <button type="button" onClick={() => dialogRef.close()}>
            Cancel
          </button>
          <button disabled={saving() || !name()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
