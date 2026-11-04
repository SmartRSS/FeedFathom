import { expect, test } from "bun:test";
import { SINGLE_PANE_QUERY } from "../behavior.ts";

const css = await Bun.file(new URL("../style.css", import.meta.url)).text();
const mediaQueries = [...css.matchAll(/@media ([^{]+)\{/gu)].map(
  ([, query = ""]) => query.trim().replaceAll(/\s+/gu, " "),
);

// style.css cannot import the constant, so it repeats it. A copy that drifts
// would let the stylesheet show three panes while switchPane animates as if
// one were showing, or the other way round.
test("every single-pane media query in style.css is SINGLE_PANE_QUERY", () => {
  const singlePane = mediaQueries.filter(
    (query) => query.includes("768px") || query.includes("portrait"),
  );
  expect(singlePane.length).toBeGreaterThanOrEqual(2);
  for (const query of singlePane) expect(query).toBe(SINGLE_PANE_QUERY);
});

test("each copy points at the constant", () => {
  const copies = css.split(`@media ${SINGLE_PANE_QUERY}`).slice(0, -1);
  expect(copies.length).toBeGreaterThanOrEqual(2);
  for (const before of copies)
    expect(before.slice(-400)).toContain("SINGLE_PANE_QUERY");
});
