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
// a path of the app's own, which is already safe.
const newsletterArticlePrefix = "/article/";
export const newsletterArticlePath = (guid: string) =>
  `${newsletterArticlePrefix}${guid}`;
const isNewsletterArticlePath = (value: string) =>
  value.startsWith(newsletterArticlePrefix);

export const safeArticleUrl = (value: string, baseUrl: string): string =>
  isNewsletterArticlePath(value) ? value : safeHttpUrl(value, baseUrl);
// An absolute http(s) URL with no username or password, resolved against
// `base` when given; undefined for anything else. Credentials are refused
// because a URL carrying them would send them to whatever host it names.
export const httpUrlWithoutCredentials = (
  value: string,
  base?: string,
): URL | undefined => {
  const url = URL.parse(value, base);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return undefined;
  return url.username === "" && url.password === "" ? url : undefined;
};
