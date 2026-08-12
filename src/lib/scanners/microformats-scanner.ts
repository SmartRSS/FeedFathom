import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

// Unlike RSS/Atom/JSON Feed, microformats2 (h-feed/h-entry) has no separate
// feed file to link to -- the markup lives directly in the page, so the
// page itself is the feed when it's present.
export const scanMicroformats = (
  currentUrl: URL,
  page: ScannerPage,
): FeedData[] =>
  page.hasMicroformatEntries
    ? [{ title: "This page (h-entry)", url: currentUrl.href }]
    : [];
