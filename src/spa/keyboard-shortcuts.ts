type ArticleCommand =
  | "delete"
  | "first"
  | "help"
  | "last"
  | "next"
  | "open"
  | "openOriginal"
  | "previous"
  | "read"
  | "refresh"
  | "selectAll"
  | "toFeeds"
  | "toggleRead"
  | "toggleSelection";

type KeyPress = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">;

export function mapArticleKey(event: KeyPress): ArticleCommand | null {
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "ArrowLeft":
      return "toFeeds";
    case "Home":
      return "first";
    case "End":
      return "last";
    case " ":
      return "toggleSelection";
    case "Delete":
      return "delete";
  }
  if (event.ctrlKey || event.metaKey)
    return event.key.toLowerCase() === "a" ? "selectAll" : null;
  if (event.key.toLowerCase() === "m") return "toggleRead";
  if (event.altKey) return null;
  switch (event.key) {
    case "j":
      return "next";
    case "k":
      return "previous";
    case "o":
      return "open";
    case "Enter":
      return "read";
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

export const shortcutHelp: [string[][], string][] = [
  [[["↓"], ["↑"]], "Select the next / previous article"],
  [[["j"], ["k"]], "Same, the RSS-reader standard keys"],
  [
    [
      ["Ctrl", "↓"],
      ["Ctrl", "↑"],
    ],
    "Move the cursor without selecting",
  ],
  [[["Home"], ["End"]], "Select the first / last article"],
  [[["Space"]], "Add or remove the article at the cursor"],
  [[["Enter"]], "Read the article at the cursor"],
  [[["v"]], "Open the original in a new tab"],
  [[["o"]], "Move between the list and the reader pane"],
  [[["m"]], "Mark read / unread"],
  [[["Delete"]], "Delete the selection"],
  [[["Ctrl", "A"]], "Select all articles"],
  [[["←"]], "Back to the feed list"],
  [[["r"]], "Refresh"],
  [[["?"], ["Esc"]], "This cheat sheet / close"],
];

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
