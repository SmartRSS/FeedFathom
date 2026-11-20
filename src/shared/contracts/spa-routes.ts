const activationPrefix = "/activate/";
const passwordResetPrefix = "/password-reset/";

export const activationPath = (token: string) => `${activationPrefix}${token}`;
export const passwordResetPath = (token: string) =>
  `${passwordResetPrefix}${token}`;

const tokenAfter = (prefix: string, pathname: string): string | undefined => {
  if (!pathname.startsWith(prefix)) return undefined;
  const token = pathname.slice(prefix.length);
  return token && !token.includes("/") ? token : undefined;
};

export const activationToken = (pathname: string) =>
  tokenAfter(activationPrefix, pathname);
export const passwordResetToken = (pathname: string) =>
  tokenAfter(passwordResetPrefix, pathname);

type PreviewRoute = { feedUrl: string } | { newsletter: true };

export const previewPathname = "/preview";

export const previewPath = (route: PreviewRoute): string =>
  "feedUrl" in route
    ? `${previewPathname}?${new URLSearchParams({ feedUrl: route.feedUrl }).toString()}`
    : `${previewPathname}?newsletter`;

export const parsePreviewQuery = (
  query: URLSearchParams,
): { feedUrl?: string; newsletter?: true } => {
  if (query.has("newsletter")) return { newsletter: true };
  const feedUrl = query.get("feedUrl");
  return feedUrl ? { feedUrl } : {};
};
