const isHttp = (url: URL) =>
  url.protocol === "http:" || url.protocol === "https:";

// An absolute http(s) URL with no username or password; undefined for
// anything else. Credentials are refused because a URL carrying them would
// send them to whatever host it names.
export const httpUrlWithoutCredentials = (value: string): URL | undefined => {
  const url = URL.parse(value);
  if (!url || !isHttp(url)) return undefined;
  return url.username === "" && url.password === "" ? url : undefined;
};

// Resolve a possibly-relative URL against a base and keep only http(s).
// Anything else -- javascript:, data:, an unparseable string -- becomes the
// empty string, so a hostile feed cannot put a scheme of its choosing into an
// href the SPA renders.
export const safeHttpUrl = (value: string, baseUrl: string): string => {
  if (!value) return "";
  const url = URL.parse(value) ?? URL.parse(value, baseUrl);
  return url && isHttp(url) ? url.href : "";
};

// Newsletter articles have no page of their own. The mail handler stores each
// under a path no route serves, which keeps the URL unique per message, so
// they get no link.
const newsletterArticlePrefix = "/article/";
export const newsletterArticlePath = (guid: string) =>
  `${newsletterArticlePrefix}${guid}`;
const isNewsletterArticlePath = (value: string) =>
  value.startsWith(newsletterArticlePrefix);

export const safeArticleUrl = (value: string, baseUrl: string): string =>
  isNewsletterArticlePath(value) ? "" : safeHttpUrl(value, baseUrl);
