// The SPA routes other programs link to: the server puts the account links
// into mail, and the extension opens /preview. The SPA routes each through
// the parser beside its builder.

const activationPrefix = "/activate/";
const passwordResetPrefix = "/password-reset/";

export const activationPath = (token: string) => `${activationPrefix}${token}`;
export const passwordResetPath = (token: string) =>
  `${passwordResetPrefix}${token}`;

// The token is the whole rest of the path, one segment.
const tokenAfter = (prefix: string, pathname: string): string | undefined => {
  if (!pathname.startsWith(prefix)) return undefined;
  const token = pathname.slice(prefix.length);
  return token && !token.includes("/") ? token : undefined;
};

export const activationToken = (pathname: string) =>
  tokenAfter(activationPrefix, pathname);
export const passwordResetToken = (pathname: string) =>
  tokenAfter(passwordResetPrefix, pathname);

// A feed to preview, or a request to mint a newsletter address: the SPA
// knows the mail domain, so the address format lives in one place.
type PreviewRoute = { feedUrl: string } | { newsletter: true };

export const previewPathname = "/preview";

export const previewPath = (route: PreviewRoute): string =>
  "feedUrl" in route
    ? `${previewPathname}?${new URLSearchParams({ feedUrl: route.feedUrl }).toString()}`
    : `${previewPathname}?newsletter`;

// What a /preview query asks for; empty for a bare /preview.
export const parsePreviewQuery = (
  query: URLSearchParams,
): { feedUrl?: string; newsletter?: true } => {
  if (query.has("newsletter")) return { newsletter: true };
  const feedUrl = query.get("feedUrl");
  return feedUrl ? { feedUrl } : {};
};
