import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const dashboardPaneSchema = Type.Union([
  Type.Literal("sources"),
  Type.Literal("articles"),
  Type.Literal("reader"),
]);
const dashboardHistoryStateSchema = Type.Object(
  { feedFathomPane: dashboardPaneSchema },
  { additionalProperties: true },
);

const normalizedNextPath = (value: string): string | undefined => {
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  try {
    if (decodeURIComponent(value).includes("\\")) return undefined;
    const url = new URL(value, "http://localhost");
    return url.origin === "http://localhost" &&
      url.pathname !== "/login" &&
      url.pathname !== "/register"
      ? url.pathname + url.search
      : undefined;
  } catch {
    return undefined;
  }
};

export type SelectionModifiers = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function transitionArticleSelection(
  selectedIndexes: ReadonlySet<number>,
  index: number,
  selectionAnchor: number | undefined,
  modifiers: SelectionModifiers = {},
): { anchor: number; indexes: Set<number> } {
  const indexes = new Set(selectedIndexes);
  let anchor = selectionAnchor ?? index;

  if (modifiers.shiftKey) {
    if (!modifiers.ctrlKey) indexes.clear();
    for (
      let item = Math.min(anchor, index);
      item <= Math.max(anchor, index);
      item++
    )
      indexes.add(item);
  } else if (modifiers.ctrlKey || modifiers.metaKey) {
    indexes.has(index) ? indexes.delete(index) : indexes.add(index);
    anchor = index;
  } else {
    indexes.clear();
    indexes.add(index);
    anchor = index;
  }

  return { anchor, indexes };
}

export function removalOutcome<T>(
  items: readonly T[],
  indexes: ReadonlySet<number>,
): { nextIndex: number; remaining: T[] } {
  const remaining = items.filter((_, index) => !indexes.has(index));
  const nextIndex = Math.min(Math.min(...indexes), remaining.length - 1);
  return { nextIndex, remaining };
}

export function soleSelectedIndex(
  selectedIndexes: ReadonlySet<number>,
): number | undefined {
  if (selectedIndexes.size !== 1) return undefined;
  return selectedIndexes.values().next().value;
}

export type DashboardPane = Static<typeof dashboardPaneSchema>;

export function parseDashboardPane(state: unknown): DashboardPane | undefined {
  return Value.Check(dashboardHistoryStateSchema, state)
    ? state.feedFathomPane
    : undefined;
}

export function withDashboardPane(
  state: unknown,
  feedFathomPane: DashboardPane,
): Record<string, unknown> {
  return {
    ...(typeof state === "object" && state !== null ? state : {}),
    feedFathomPane,
  };
}

export type PaneSwitchHost = {
  matches(query: string): boolean;
  startViewTransition:
    | ((update: () => void) => { updateCallbackDone: Promise<void> })
    | undefined;
};

// Applies a pane switch, cross-faded where it reads as one (#990). Only the
// phone layout shows one pane at a time; on a wider screen every pane stays
// put and a fade would only dim the whole page. A browser that already
// animated the navigation itself (a swipe back) gets no second animation.
// Returns when an animated switch has been applied; an instant one already
// has, and returns undefined.
export function switchPane(
  update: () => void,
  host: PaneSwitchHost,
  browserAnimated = false,
): Promise<void> | undefined {
  if (
    !host.startViewTransition ||
    browserAnimated ||
    !host.matches("(max-width: 768px)") ||
    host.matches("(prefers-reduced-motion: reduce)")
  ) {
    update();
    return undefined;
  }
  return host.startViewTransition(update).updateCallbackDone;
}

export function safeNextPath(value: string | null | undefined): string {
  return (
    (typeof value === "string" ? normalizedNextPath(value) : undefined) ?? "/"
  );
}

export function loginPath(next: string): string {
  return `/login?${new URLSearchParams({ next: safeNextPath(next) })}`;
}

export function registerPath(next: string): string {
  return `/register?${new URLSearchParams({ next: safeNextPath(next) })}`;
}

export type Route =
  | { name: "activate"; token: string }
  | { name: "login" | "register"; next: string }
  | { name: "admin" | "dashboard" | "options" | "passwordReset" }
  | { name: "passwordResetConfirm"; token: string }
  | { feedUrl?: string; name: "preview" };

export function resolveRoute(path: string): Route {
  const url = new URL(path, "http://localhost");
  const activationToken = /^\/activate\/([^/]+)$/.exec(url.pathname)?.[1];
  if (activationToken) return { name: "activate", token: activationToken };
  const resetToken = /^\/password-reset\/([^/]+)$/.exec(url.pathname)?.[1];
  if (resetToken) return { name: "passwordResetConfirm", token: resetToken };

  switch (url.pathname) {
    case "/admin":
      return { name: "admin" };
    case "/login":
      return {
        name: "login",
        next: safeNextPath(url.searchParams.get("next")),
      };
    case "/options":
      return { name: "options" };
    case "/password-reset":
      return { name: "passwordReset" };
    case "/preview": {
      const feedUrl = url.searchParams.get("feedUrl");
      return feedUrl ? { feedUrl, name: "preview" } : { name: "preview" };
    }
    case "/register":
      return {
        name: "register",
        next: safeNextPath(url.searchParams.get("next")),
      };
    default:
      return { name: "dashboard" };
  }
}
