import {
  scannerPageFromDocument,
  scannerPageFromHtml,
  type ScannerPage,
} from "#shared/scanners/scanner-page.ts";
import { scanBitchute } from "#shared/scanners/bitchute-scanner.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { scanGenerator } from "#shared/scanners/generator-scanner.ts";
import { scanGithub } from "#shared/scanners/github-scanner.ts";
import { scanHead } from "#shared/scanners/head-scanner.ts";
import { scanHiveblog } from "#shared/scanners/hiveblog-scanner.ts";
import { scanLinkFeed } from "#shared/scanners/link-feed-scanner.ts";
import { scanMicroformats } from "#shared/scanners/microformats-scanner.ts";
import { scanOdsee } from "#shared/scanners/odsee-scanner.ts";
import { scanSteemit } from "#shared/scanners/steemit-scanner.ts";
import { scanVimeo } from "#shared/scanners/vimeo-scanner.ts";
import { scanXml } from "#shared/scanners/xml-scanner.ts";
import { scanYoutube } from "#shared/scanners/youtube-scanner.ts";

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
  scanMicroformats,
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
