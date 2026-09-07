import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

// In-app replacements for the last native dialogs in the app (#698).
// Native prompt()/confirm() block the event loop, can be suppressed by the
// browser (after which folder creation silently no-ops), are poor on touch
// screens, and can't follow the page's theme. A single <dialog> hosted once
// in main.tsx serves every call site; showModal() provides the focus trap,
// the inert background and the Esc-to-dismiss handling for free.

// Both variants store one common resolve signature (the broadest of the
// two), so dismissals can be routed without casting; the public helpers
// adapt it back to their own promise type at creation.
type DialogRequest =
  | {
      kind: "confirm";
      message: string;
      danger: boolean;
      resolve(value: boolean | string | null): void;
    }
  | {
      kind: "prompt";
      label: string;
      initial: string;
      resolve(value: boolean | string | null): void;
    }
  | {
      // The keyboard cheat sheet (#709): same host, same dismissal
      // mechanics, no value to resolve. Invoked by the `?` shortcut and by
      // the "Keyboard shortcuts" button on the options page.
      kind: "help";
      resolve(value: boolean | string | null): void;
    };

// Every shortcut, so the cheat sheet and the handler can't drift apart.
// Each entry lists the key groups that mean the same thing.
const SHORTCUTS: [string[][], string][] = [
  [[["↑"], ["↓"]], "Focus previous / next article"],
  [[["j"], ["k"]], "Same, the RSS-reader standard keys"],
  [[["Space"]], "Select the article at the cursor"],
  [[["Enter"], ["v"]], "Open the original in a new tab"],
  [[["o"]], "Move between the list and the reader pane"],
  [[["m"]], "Mark read / unread"],
  [[["Delete"]], "Delete the selection"],
  [[["Ctrl", "A"]], "Select all articles"],
  [[["←"]], "Back to the feed list"],
  [[["r"]], "Refresh"],
  [[["?"], ["Esc"]], "This cheat sheet / close"],
];

function Shortcuts() {
  return (
    <dl class="app-dialog-shortcuts">
      <For each={SHORTCUTS}>
        {([groups, description]) => (
          <div>
            <dt>
              <For each={groups}>
                {(keys, groupIndex) => (
                  <>
                    {groupIndex() > 0 ? " or " : ""}
                    <For each={keys}>
                      {(key, keyIndex) => (
                        <>
                          {keyIndex() > 0 ? " + " : ""}
                          <kbd>{key}</kbd>
                        </>
                      )}
                    </For>
                  </>
                )}
              </For>
            </dt>
            <dd>{description}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

const [request, setRequest] = createSignal<DialogRequest>();

// Mirrors the native call shapes so the call sites barely change: cancel,
// Esc and backdrop-click resolve exactly like the native cancel path
// (false for confirm, null for prompt), so existing `if (!name?.trim())
// return` guards keep working.
// The value a dismissal (Cancel, Esc, backdrop click) resolves with, matching
// the native dialogs' cancel results. Help resolves on every dismissal too;
// its helper just ignores the value.
const cancelValue = (current: DialogRequest) =>
  current.kind === "prompt" ? null : false;

export function confirmDialog(
  message: string,
  options?: { danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) =>
    setRequest({
      danger: options?.danger ?? false,
      kind: "confirm",
      message,
      resolve: (value) => resolve(value === true),
    }),
  );
}

export function promptDialog(
  label: string,
  initial = "",
): Promise<string | null> {
  return new Promise((resolve) =>
    setRequest({
      initial,
      kind: "prompt",
      label,
      resolve: (value) => resolve(typeof value === "string" ? value : null),
    }),
  );
}

// No value: the cheat sheet only ever resolves through a dismissal.
export function helpDialog(): Promise<void> {
  return new Promise((resolve) =>
    setRequest({ kind: "help", resolve: () => resolve() }),
  );
}

export function DialogHost() {
  let dialogRef: HTMLDialogElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let confirmRef: HTMLButtonElement | undefined;
  // Captured before the dialog can move focus, like ContextMenu's invoker.
  let invoker: Element | null = null;

  const restoreFocus = () => {
    if (invoker instanceof HTMLElement) invoker.focus();
    invoker = null;
  };

  createEffect(() => {
    const current = request();
    if (!current) return;
    invoker = document.activeElement;
    queueMicrotask(() => {
      dialogRef?.showModal();
      if (current.kind === "prompt") inputRef?.select();
      else confirmRef?.focus();
    });
  });
  onCleanup(() => {
    // Route teardown with a dialog still open: resolve the pending promise
    // so no caller awaits forever, then drop the top-layer state.
    const current = request();
    if (!current) return;
    current.resolve(cancelValue(current));
    setRequest(undefined);
    dialogRef?.close();
  });

  const finish = (value: boolean | string | null) => {
    const current = request();
    if (!current) return;
    current.resolve(value);
    setRequest(undefined);
    dialogRef?.close();
    restoreFocus();
  };

  const cancel = () => {
    const current = request();
    if (current) finish(cancelValue(current));
  };

  const submitPrompt = () => {
    const current = request();
    if (current?.kind !== "prompt") return;
    finish(inputRef?.value ?? "");
  };

  // Typed accessors: the JSX below needs the narrowed union members
  // (label/initial vs message/danger), which a bare kind check inside an
  // attribute expression doesn't give TypeScript.
  const text = () => {
    const current = request();
    if (!current) return "";
    return current.kind === "prompt"
      ? current.label
      : current.kind === "confirm"
        ? current.message
        : "";
  };
  const promptRequest = () => {
    const current = request();
    return current?.kind === "prompt" ? current : undefined;
  };
  const helpRequest = () => {
    const current = request();
    return current?.kind === "help" ? current : undefined;
  };
  const danger = () => {
    const current = request();
    return current?.kind === "confirm" && current.danger;
  };

  return (
    <Show when={request()}>
      {(current) => (
        <dialog
          class="app-dialog"
          // Esc fires cancel before close; resolving via cancel() keeps the
          // same false/null contract as the Cancel button.
          onCancel={(event) => {
            event.preventDefault();
            cancel();
          }}
          onClick={(event) => {
            // Clicks on ::backdrop land on the <dialog> element itself;
            // clicks inside land on the form or its children.
            if (event.target === dialogRef) cancel();
          }}
          onClose={() => {
            // Any close not already routed through finish() (e.g. a stray
            // form submission) still must not leave the promise pending.
            cancel();
          }}
          ref={dialogRef}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (current().kind === "prompt") submitPrompt();
              else if (current().kind === "confirm") finish(true);
              else cancel();
            }}
          >
            <Show
              when={helpRequest()}
              fallback={
                <label>
                  {text()}
                  <Show when={promptRequest()}>
                    {(prompt) => (
                      <input
                        autofocus
                        ref={inputRef}
                        type="text"
                        value={prompt().initial}
                      />
                    )}
                  </Show>
                </label>
              }
            >
              <h2 class="app-dialog-title">Keyboard shortcuts</h2>
              <Shortcuts />
            </Show>
            <div class="app-dialog-actions">
              <Show when={!helpRequest()}>
                <button type="button" onClick={cancel}>
                  Cancel
                </button>
              </Show>
              <button
                classList={{ "app-dialog-danger": danger() }}
                ref={confirmRef}
                type="submit"
              >
                {helpRequest() ? "Close" : "OK"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </Show>
  );
}
