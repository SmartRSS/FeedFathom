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

// Keystrokes in text fields are content, not commands. Structural checks
// let unit tests pass plain shapes without a DOM.
export function isTextEntry(target: unknown): boolean {
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
