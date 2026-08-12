import type { ScannerPage } from "../scanner-page.ts";
import type { FeedData } from "./feed-data-type.ts";

export const scanGenerator = (
  currentUrl: URL,
  page: ScannerPage,
): FeedData[] =>
  page.generator?.includes("WordPress")
    ? [{ title: "Wordpress Feed", url: `${currentUrl.origin}/feed` }]
    : [];
