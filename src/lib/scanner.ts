import {
  scannerPageFromDocument,
  scannerPageFromHtml,
  type ScannerPage,
} from "./scanner-page.ts";
import { scanBitchute } from "./scanners/bitchute-scanner.ts";
import type { FeedData } from "./scanners/feed-data-type.ts";
import { scanGenerator } from "./scanners/generator-scanner.ts";
import { scanGithub } from "./scanners/github-scanner.ts";
import { scanHead } from "./scanners/head-scanner.ts";
import { scanHiveblog } from "./scanners/hiveblog-scanner.ts";
import { scanLinkFeed } from "./scanners/link-feed-scanner.ts";
import { scanOdsee } from "./scanners/odsee-scanner.ts";
import { scanSteemit } from "./scanners/steemit-scanner.ts";
import { scanVimeo } from "./scanners/vimeo-scanner.ts";
import { scanXml } from "./scanners/xml-scanner.ts";
import { scanYoutube } from "./scanners/youtube-scanner.ts";

const scanners = [
  scanXml,
  scanHead,
  scanBitchute,
  scanGithub,
  scanHiveblog,
  scanOdsee,
  scanSteemit,
  scanVimeo,
  scanYoutube,
  scanGenerator,
  scanLinkFeed,
];

const scanPage = (address: string, page: ScannerPage) => {
  const feedDataList: FeedData[] = [];
  const addressUrl = new URL(address);
  const seenUrls = new Set<string>();

  const results = scanners.map((scanner) => scanner(addressUrl, page));

  for (const result of results) {
    for (const feedData of result) {
      const normalizedUrl = new URL(feedData.url, address).href;

      // Skip if we've already seen this URL
      if (seenUrls.has(normalizedUrl)) {
        continue;
      }

      seenUrls.add(normalizedUrl);
      feedDataList.push({
        title: feedData.title,
        url: normalizedUrl,
      });
    }
  }

  if (feedDataList.length === 0) {
    // Ensure we don't create malformed URLs with double protocols
    const cleanAddress = address.replace(/^https?:\/\//, "");
    feedDataList.push({
      title: "Attempt to use OpenRSS",
      url: `https://openrss.org/${cleanAddress}`,
    });
  }

  return feedDataList;
};

export const scan = (address: string, document_: Document) =>
  scanPage(address, scannerPageFromDocument(address, document_));

export const scanHtml = (address: string, html: string) =>
  scanPage(address, scannerPageFromHtml(address, html));
