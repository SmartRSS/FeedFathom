import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { shortcutHelp } from "./keyboard-shortcuts.ts";

export const isDialogOpen = () =>
  document.querySelector("dialog[open]") !== null;

type DialogRequest =
  | {
      kind: "confirm";
      title: string;
      message: string;
      danger: boolean;
      confirmLabel: string;
      resolve(value: boolean | string | null): void;
    }
  | {
      kind: "prompt";
      title: string;
      label: string;
      initial: string;
      confirmLabel: string;
      resolve(value: boolean | string | null): void;
    }
  | {
      kind: "help";
      resolve(value: boolean | string | null): void;
    };

function Shortcuts() {
  return (
    <dl class="app-dialog-shortcuts">
      <For each={shortcutHelp}>
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

const cancelValue = (current: DialogRequest) =>
  current.kind === "prompt" ? null : false;

function show(next: DialogRequest) {
  const pending = request();
  pending?.resolve(cancelValue(pending));
  setRequest(next);
}

export function confirmDialog(
  title: string,
  message: string,
  options: { confirmLabel: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) =>
    show({
      confirmLabel: options.confirmLabel,
      danger: options.danger ?? false,
      kind: "confirm",
      message,
      resolve: (value) => resolve(value === true),
      title,
    }),
  );
}

export function promptDialog(
  title: string,
  label: string,
  options: { confirmLabel: string; initial?: string },
): Promise<string | null> {
  return new Promise((resolve) =>
    show({
      confirmLabel: options.confirmLabel,
      initial: options.initial ?? "",
      kind: "prompt",
      label,
      resolve: (value) => resolve(typeof value === "string" ? value : null),
      title,
    }),
  );
}

export function helpDialog(): Promise<void> {
  return new Promise((resolve) =>
    show({ kind: "help", resolve: () => resolve() }),
  );
}

export function DialogHost() {
  let dialogRef: HTMLDialogElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let confirmRef: HTMLButtonElement | undefined;
  let invoker: Element | null = null;

  const restoreFocus = () => {
    if (invoker instanceof HTMLElement) invoker.focus();
    invoker = null;
  };

  createEffect(request, (current) => {
    if (!current) return;
    if (!dialogRef?.open) invoker = document.activeElement;
    queueMicrotask(() => {
      if (!dialogRef?.open) dialogRef?.showModal();
      if (current.kind === "prompt") inputRef?.select();
      else confirmRef?.focus();
    });
  });
  onCleanup(() => {
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

  const text = () => {
    const current = request();
    if (!current) return "";
    return current.kind === "prompt"
      ? current.label
      : current.kind === "confirm"
        ? current.message
        : "";
  };
  const title = () => {
    const current = request();
    return current?.kind === "help"
      ? "Keyboard shortcuts"
      : (current?.title ?? "");
  };
  const promptRequest = () => {
    const current = request();
    return current?.kind === "prompt" ? current : undefined;
  };
  const helpRequest = () => {
    const current = request();
    return current?.kind === "help" ? current : undefined;
  };
  const confirmLabel = () => {
    const current = request();
    return current?.kind === "help" ? "" : (current?.confirmLabel ?? "");
  };
  const danger = () => {
    const current = request();
    return current?.kind === "confirm" && current.danger;
  };

  return (
    <Show when={request()}>
      {(current) => (
        <dialog
          class={[
            "app-dialog",
            { "app-dialog-wide": current().kind === "help" },
          ]}
          aria-describedby={
            current().kind === "confirm" ? "app-dialog-prompt" : undefined
          }
          aria-labelledby="app-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            cancel();
          }}
          onClick={(event) => {
            if (event.target === dialogRef) cancel();
          }}
          onClose={() => {
            if (!dialogRef?.open) cancel();
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
            <h2 class="app-dialog-title" id="app-dialog-title">
              {title()}
            </h2>
            <button
              aria-label="Close"
              class="app-dialog-close"
              tabindex={-1}
              type="button"
              onClick={cancel}
            >
              ×
            </button>
            <Show
              when={helpRequest()}
              fallback={
                <Show
                  when={promptRequest()}
                  fallback={<p id="app-dialog-prompt">{text()}</p>}
                >
                  {(prompt) => (
                    <label>
                      <span id="app-dialog-prompt">{text()}</span>
                      <input
                        autofocus
                        ref={inputRef}
                        type="text"
                        value={prompt().initial}
                      />
                    </label>
                  )}
                </Show>
              }
            >
              <Shortcuts />
            </Show>
            <div class="app-dialog-actions">
              <Show when={!helpRequest()}>
                <button type="button" onClick={cancel}>
                  Cancel
                </button>
              </Show>
              <button
                class={{
                  "app-dialog-danger": danger(),
                  "button-primary": !danger(),
                }}
                ref={confirmRef}
                type="submit"
              >
                {helpRequest() ? "Close" : confirmLabel()}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </Show>
  );
}
