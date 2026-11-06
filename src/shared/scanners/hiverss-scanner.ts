import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { hostIs } from "#shared/scanners/host.ts";

const hiverssHosts = ["steemit.com", "hive.blog"] as const;

export const scanHiverss = (
  currentUrl: URL,
  _page: ScannerPage,
): FeedData[] => {
  if (!hiverssHosts.some((host) => hostIs(currentUrl, host))) {
    return [];
  }
  if (currentUrl.pathname === "/") return [];

  return [
    {
      title: "Channel feed",
      url: `https://www.hiverss.com${currentUrl.pathname}/feed`,
    },
  ];
};
