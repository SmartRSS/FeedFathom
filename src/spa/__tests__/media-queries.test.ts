import { expect, test } from "bun:test";
import {
  FINE_POINTER_QUERY,
  SINGLE_PANE_QUERY,
  TWO_PANE_QUERY,
} from "../panes.ts";

const css = await Bun.file(new URL("../style.css", import.meta.url)).text();
const mediaQueries = [...css.matchAll(/@media ([^{]+)\{/gu)].map(
  ([, query = ""]) => query.trim().replaceAll(/\s+/gu, " "),
);

// style.css cannot import the constants, so it repeats them. A copy that
// drifts would let the stylesheet show three panes while switchPane animates
// as if one were showing, or the other way round.
test("every single-pane media query in style.css is SINGLE_PANE_QUERY", () => {
  const singlePane = mediaQueries.filter(
    (query) => query.includes("768px") || query.includes("portrait"),
  );
  expect(singlePane.length).toBeGreaterThanOrEqual(2);
  for (const query of singlePane) expect(query).toBe(SINGLE_PANE_QUERY);
});

test("the two-pane layer in style.css is TWO_PANE_QUERY", () => {
  const twoPane = mediaQueries.filter((query) => query.includes("landscape"));
  expect(twoPane).toEqual([TWO_PANE_QUERY]);
});

// The dense mouse layout and the hover prefetch answer the same question.
test("every hover-capable layer in style.css is FINE_POINTER_QUERY", () => {
  const hover = mediaQueries.filter((query) => query.includes("hover: hover"));
  expect(hover.length).toBeGreaterThanOrEqual(1);
  for (const query of hover) expect(query).toBe(FINE_POINTER_QUERY);
});
