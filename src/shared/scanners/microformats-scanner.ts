import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

export const scanMicroformats = (
  currentUrl: URL,
  page: ScannerPage,
): FeedData[] =>
  page.hasMicroformatEntries
    ? [{ title: "This page (h-entry)", url: currentUrl.href }]
    : [];
