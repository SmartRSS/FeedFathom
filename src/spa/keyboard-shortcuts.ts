// The industry-standard keyboard vocabulary (#709) layered on top of the
// dashboard's existing arrow/Space/Delete/Ctrl+A/Enter handling. Pure on
// purpose: the keydown handler in dashboard.tsx owns every side effect, this
// only decides which shortcut (if any) an event means, and whether a key
// press landed in something the person is typing into.

export type ArticleShortcut =
  | "next"
  | "previous"
  | "open"
  | "openOriginal"
  | "refresh"
  | "help";

// Plain letters only: every modifier combination keeps its browser or
// existing-app meaning, so a chorded press is never a shortcut. The `m`
// read/unread toggle predates this module (#682) and stays in dashboard.tsx.
export function mapArticleShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
): ArticleShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "j":
      return "next";
    case "k":
      return "previous";
    case "o":
      return "open";
    case "v":
      return "openOriginal";
    case "r":
      return "refresh";
    case "?":
      return "help";
    default:
      return null;
  }
}

// Focus sitting in a text field means keystrokes are content, not commands.
// Same set the tree filter and dialog inputs need, so the shortcuts stay
// quiet while someone is filtering feeds or typing a folder name. Structurally
// typed rather than instanceof-checked, so unit tests can pass plain shapes
// without a DOM; KeyboardEvent.target is only ever an Element here anyway.
export function isTextEntry(target: unknown): boolean {
  // Structural narrowing via `in`, no type assertion, so unit tests can pass
  // plain shapes without a DOM.
  if (
    typeof target === "object" &&
    target !== null &&
    "isContentEditable" in target &&
    target.isContentEditable === true
  )
    return true;
  if (typeof target !== "object" || target === null || !("nodeName" in target))
    return false;
  const tag =
    typeof target.nodeName === "string" ? target.nodeName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
