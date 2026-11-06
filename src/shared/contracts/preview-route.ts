// The SPA's /preview route, which the extension opens and the SPA parses:
// a feed to preview, or a request to mint a newsletter address.
export type PreviewRoute = { feedUrl: string } | { newsletter: true };

export const previewPath = (route: PreviewRoute): string =>
  "feedUrl" in route
    ? `/preview?${new URLSearchParams({ feedUrl: route.feedUrl }).toString()}`
    : "/preview?newsletter";
