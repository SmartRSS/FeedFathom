import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

export const scanGenerator = (
  currentUrl: URL,
  page: ScannerPage,
): FeedData[] =>
  page.generator?.includes("WordPress")
    ? [{ title: "Wordpress Feed", url: `${currentUrl.origin}/feed` }]
    : [];
