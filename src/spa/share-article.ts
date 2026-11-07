// Shares an article's link (#724): the Web Share sheet where the platform
// has one (mobile PWA), clipboard copy as the desktop fallback. User-cancel
// of the share sheet is normal, not an error, and is reported as "dismissed"
// so the caller stays quiet. A clipboard that is denied, or missing in an
// insecure context, is "failed".
type ShareOutcome = "copied" | "dismissed" | "failed" | "shared";
type ShareSheet = { share?: (data: ShareData) => Promise<void> };
type ClipboardWriter = { writeText(text: string): Promise<void> };

export async function shareArticle(
  article: { title?: null | string; url?: null | string },
  navigatorLike: ShareSheet = navigator,
  clipboardLike: ClipboardWriter | undefined = navigator.clipboard,
): Promise<ShareOutcome> {
  const url = article.url ?? "";
  if (!url) return "dismissed";
  if (typeof navigatorLike.share === "function") {
    try {
      await navigatorLike.share({
        ...(article.title ? { title: article.title } : {}),
        url,
      });
      return "shared";
    } catch (cause) {
      // A DOMException named AbortError is the spec's "user closed the
      // sheet"; anything else is a real failure worth the clipboard path.
      if (cause instanceof DOMException && cause.name === "AbortError")
        return "dismissed";
    }
  }
  if (!clipboardLike) return "failed";
  try {
    await clipboardLike.writeText(url);
  } catch (cause) {
    if (cause instanceof DOMException) return "failed";
    throw cause;
  }
  return "copied";
}
