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
