import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

const baseUrl = "https://github.com/" as const;

const repoPattern = new RegExp(`^${baseUrl}(.+/.+)$`, "u");

export const scanGithub = (currentUrl: URL, _page: ScannerPage): FeedData[] => {
  const address = currentUrl.href;
  const repoName = address.match(repoPattern)?.[1];
  if (!repoName) {
    return [];
  }

  return [
    { title: `${repoName} - Releases`, url: `${repoName}/releases.atom` },
  ];
};
