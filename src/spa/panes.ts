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

// Discover opened over the panes is a history entry of its own, so Back
// closes it rather than leaving for the page before the dashboard. It is
// a flag beside the pane rather than a fourth pane: Discover switches
// between panes of its own, and withDashboardPane keeps the flag on those.
const discoveryHistoryStateSchema = Type.Object(
  { feedFathomDiscovery: Type.Literal(true) },
  { additionalProperties: true },
);

export function isDiscoveryEntry(state: unknown): boolean {
  return Value.Check(discoveryHistoryStateSchema, state);
}

export function withDiscovery(
  state: unknown,
  open: boolean,
): Record<string, unknown> {
  const copy: Record<string, unknown> =
    typeof state === "object" && state !== null ? { ...state } : {};
  if (open) copy["feedFathomDiscovery"] = true;
  else delete copy["feedFathomDiscovery"];
  return copy;
}

// The address an in-app navigation left from. Navigating from a page
// outside the panes straight back to it is a Back, so Options' way home
// does not stack a second dashboard entry over Options for the system Back
// to step through.
const fromHistoryStateSchema = Type.Object(
  { feedFathomFrom: Type.String() },
  { additionalProperties: true },
);

export function previousPath(state: unknown): string | undefined {
  return Value.Check(fromHistoryStateSchema, state)
    ? state.feedFathomFrom
    : undefined;
}

export type PaneSwitchHost = {
  matches(query: string): boolean;
  startViewTransition:
    | ((update: () => void) => { updateCallbackDone: Promise<void> })
    | undefined;
};

// When the dashboard shows one pane at a time: a phone, and a portrait
// tablet, whose width cannot fit three panes of touch-size rows. style.css
// cannot import this, so each of its copies carries a comment pointing here,
// and a unit test fails if any copy differs.
export const SINGLE_PANE_QUERY =
  "(max-width: 768px), (orientation: portrait) and (max-width: 1100px)";

// When it shows two: a landscape touch screen below 1200px, a tablet or a
// large phone turned sideways, where three panes of touch-size rows leave
// each too narrow for its names and titles. The feeds stay beside the list,
// and the reader takes the list's place while an article is open. Its one
// copy in style.css is checked the same way.
export const TWO_PANE_QUERY =
  "(orientation: landscape) and (769px <= width <= 1199px) and (pointer: coarse), (orientation: landscape) and (769px <= width <= 1199px) and (hover: none)";

// Applies a pane switch, cross-faded where it reads as one (#990). Only the
// single-pane layout shows one pane at a time; on a wider screen every pane stays
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
    !host.matches(SINGLE_PANE_QUERY) ||
    host.matches("(prefers-reduced-motion: reduce)")
  ) {
    update();
    return undefined;
  }
  return host.startViewTransition(update).updateCallbackDone;
}

// A mouse or trackpad, where resting on a row is a hover that usually means a
// click is coming. style.css repeats it, checked by the same test as the pane
// queries.
export const FINE_POINTER_QUERY = "(pointer: fine) and (hover: hover)";

// Whether the reader is out of sight until an article is opened.
export const readerHidden = () =>
  matchMedia(SINGLE_PANE_QUERY).matches || matchMedia(TWO_PANE_QUERY).matches;
