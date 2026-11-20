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

export const SINGLE_PANE_QUERY =
  "(max-width: 768px), (orientation: portrait) and (max-width: 1100px)";

export const TWO_PANE_QUERY =
  "(orientation: landscape) and (769px <= width <= 1199px) and (pointer: coarse), (orientation: landscape) and (769px <= width <= 1199px) and (hover: none)";

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

export const FINE_POINTER_QUERY = "(pointer: fine) and (hover: hover)";

export const readerHidden = () =>
  matchMedia(SINGLE_PANE_QUERY).matches || matchMedia(TWO_PANE_QUERY).matches;
