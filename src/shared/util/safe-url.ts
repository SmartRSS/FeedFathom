import { isLoopbackHostname } from "#shared/net/private-network-guard.ts";

const isHttp = (url: URL) =>
  url.protocol === "http:" || url.protocol === "https:";

export const httpUrlWithoutCredentials = (value: string): URL | undefined => {
  const url = URL.parse(value);
  if (!url || !isHttp(url)) return undefined;
  return url.username === "" && url.password === "" ? url : undefined;
};

export const secureOrigin = (value: string): string | undefined => {
  const url = URL.parse(value);
  if (!url || url.href !== `${url.origin}/`) return undefined;
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname)
    ? url.origin
    : undefined;
};

export const safeHttpUrl = (value: string, baseUrl: string): string => {
  if (!value) return "";
  const url = URL.parse(value) ?? URL.parse(value, baseUrl);
  return url && isHttp(url) ? url.href : "";
};

const newsletterArticlePrefix = "/article/";
export const newsletterArticlePath = (guid: string) =>
  `${newsletterArticlePrefix}${guid}`;
const isNewsletterArticlePath = (value: string) =>
  value.startsWith(newsletterArticlePrefix);

export const safeArticleUrl = (value: string, baseUrl: string): string =>
  isNewsletterArticlePath(value) ? "" : safeHttpUrl(value, baseUrl);
