import { createSignal, onSettled, For, Show, untrack } from "solid-js";

export type ContextMenuItem =
  | {
      kind: "action";
      label: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" };

export function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  let list: HTMLUListElement | undefined;
  let invoker: Element | null;

  const menuMargin = 8;
  const [pos, setPos] = createSignal(
    untrack(() => ({ x: props.x + 2, y: props.y + 2 })),
  );

  onSettled(() => {
    invoker = document.activeElement;
    const rect = list?.getBoundingClientRect();
    if (rect) {
      setPos({
        x: Math.max(
          menuMargin,
          Math.min(props.x + 2, window.innerWidth - menuMargin - rect.width),
        ),
        y: Math.max(
          menuMargin,
          Math.min(props.y + 2, window.innerHeight - menuMargin - rect.height),
        ),
      });
    }
    const first = list?.querySelector<HTMLElement>(
      "[role='menuitem']:not([disabled])",
    );
    first?.focus();
    document.addEventListener("pointerdown", onOutsidePointerDown);
    return () =>
      document.removeEventListener("pointerdown", onOutsidePointerDown);
  });

  const returnFocus = () => {
    if (invoker instanceof HTMLElement) invoker.focus();
  };

  const onOutsidePointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Node && list?.contains(event.target)))
      props.onClose();
  };

  const focusItemAt = (offset: number) => {
    const items = [
      ...(list?.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([disabled])",
      ) ?? []),
    ];
    if (!items.length) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next = items[(current + offset + items.length) % items.length];
    next?.focus();
  };

  const runItem = (item: ContextMenuItem) => {
    if (item.kind !== "action" || item.disabled) return;
    props.onClose();
    queueMicrotask(item.onSelect);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      returnFocus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItemAt(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItemAt(-1);
    } else if (event.key === "Tab") {
      props.onClose();
      returnFocus();
    }
  };

  const style = () => ({ left: `${pos().x}px`, top: `${pos().y}px` });

  return (
    <ul
      class="context-menu"
      onKeyDown={onKeyDown}
      ref={list}
      role="menu"
      style={style()}
    >
      <For each={props.items}>
        {(item) => (
          <Show
            when={item.kind === "action" ? item : undefined}
            fallback={<li role="separator" class="context-menu-separator" />}
          >
            {(action) => (
              <li role="none">
                <button
                  class={{ "context-menu-danger": action().danger }}
                  disabled={action().disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    runItem(action());
                  }}
                  role="menuitem"
                  tabindex={-1}
                  type="button"
                >
                  {action().label}
                </button>
              </li>
            )}
          </Show>
        )}
      </For>
    </ul>
  );
}

export function longPressHandlers(open: (x: number, y: number) => void): {
  onTouchCancel(): void;
  onTouchEnd(event: TouchEvent): void;
  onTouchMove(): void;
  onTouchStart(event: TouchEvent): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;

  const cancel = () => clearTimeout(timer);

  return {
    onTouchCancel: cancel,
    onTouchEnd(event) {
      cancel();
      if (fired) event.preventDefault();
    },
    onTouchMove: cancel,
    onTouchStart(event) {
      fired = false;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      timer = setTimeout(() => {
        fired = true;
        open(touch.clientX, touch.clientY);
      }, 500);
    },
  };
}
