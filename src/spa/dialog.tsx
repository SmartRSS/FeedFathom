import { createEffect, createSignal, onCleanup, Show } from "solid-js";

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
    };

const [request, setRequest] = createSignal<DialogRequest>();

// Mirrors the native call shapes so the call sites barely change: cancel,
// Esc and backdrop-click resolve exactly like the native cancel path
// (false for confirm, null for prompt), so existing `if (!name?.trim())
// return` guards keep working.
// The value a dismissal (Cancel, Esc, backdrop click) resolves with, matching
// the native dialogs' cancel results.
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
    return current.kind === "prompt" ? current.label : current.message;
  };
  const promptRequest = () => {
    const current = request();
    return current?.kind === "prompt" ? current : undefined;
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
              else finish(true);
            }}
          >
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
            <div class="app-dialog-actions">
              <button type="button" onClick={cancel}>
                Cancel
              </button>
              <button
                classList={{ "app-dialog-danger": danger() }}
                ref={confirmRef}
                type="submit"
              >
                OK
              </button>
            </div>
          </form>
        </dialog>
      )}
    </Show>
  );
}
