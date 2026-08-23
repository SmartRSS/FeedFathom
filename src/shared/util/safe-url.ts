// Resolve a possibly-relative URL against a base and keep only http(s).
// Anything else -- javascript:, data:, an unparseable string -- becomes the
// empty string, so a hostile feed cannot put a scheme of its choosing into an
// href the SPA renders.
export const safeHttpUrl = (value: string, baseUrl: string): string => {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    try {
      url = new URL(value, baseUrl);
    } catch {
      return "";
    }
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
};

// Newsletter articles have no source URL of their own; they are addressed by
// the app's own /article/ path, which is already safe.
export const safeArticleUrl = (value: string, baseUrl: string): string =>
  value.startsWith("/article/") ? value : safeHttpUrl(value, baseUrl);
