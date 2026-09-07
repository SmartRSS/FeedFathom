import { createSignal, onCleanup, onMount, For, Show } from "solid-js";

export type ContextMenuItem =
  | {
      kind: "action";
      label: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" };

// A custom context menu (#721): native menus can't be styled, aren't
// keyboard-accessible, and don't exist at all on long-press. role="menu"
// with roving focus between menuitems, Escape and outside-pointer
// dismissal, and focus returned to the element that had it when the menu
// opened.
export function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  let list: HTMLUListElement | undefined;
  let invoker: Element | null;

  // Anchor point, nudged so the menu never opens under the cursor where a
  // stray pointerup would immediately activate the first item. Clamped to
  // the viewport once the menu has a real size: long-press near a screen
  // edge is the common case on touch, and an unclamped menu renders its
  // items off-screen there.
  const menuMargin = 8;
  const [pos, setPos] = createSignal({ x: props.x + 2, y: props.y + 2 });

  onMount(() => {
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
    // Focus the first enabled item, like a native menu.
    const first = list?.querySelector<HTMLElement>(
      "[role='menuitem']:not([disabled])",
    );
    first?.focus();
    document.addEventListener("pointerdown", onOutsidePointerDown);
  });
  onCleanup(() =>
    document.removeEventListener("pointerdown", onOutsidePointerDown),
  );

  // Captured at mount, before any menu interaction can move focus.
  const returnFocus = () => {
    if (invoker instanceof HTMLElement) invoker.focus();
  };

  const onOutsidePointerDown = (event: PointerEvent) => {
    if (!list?.contains(event.target as Node)) props.onClose();
  };

  const focusItemAt = (offset: number) => {
    const items = [
      ...(list?.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([disabled])",
      ) ?? []),
    ];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(current + offset + items.length) % items.length];
    next?.focus();
  };

  const runItem = (item: ContextMenuItem) => {
    if (item.kind !== "action" || item.disabled) return;
    props.onClose();
    // Act after closing, so actions that open panes or dialogs don't fight
    // the menu for focus.
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
                  disabled={action().disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    runItem(action());
                  }}
                  role="menuitem"
                  tabIndex={-1}
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

// Long-press → context menu, for touch screens. Cancels on movement (that's
// a scroll) and swallows the click a released long-press would produce.
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
