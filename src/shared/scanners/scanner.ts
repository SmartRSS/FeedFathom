import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import { scanBitchute } from "#shared/scanners/bitchute-scanner.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import { scanGenerator } from "#shared/scanners/generator-scanner.ts";
import { scanGithub } from "#shared/scanners/github-scanner.ts";
import { scanHead } from "#shared/scanners/head-scanner.ts";
import { scanHiverss } from "#shared/scanners/hiverss-scanner.ts";
import { scanLinkFeed } from "#shared/scanners/link-feed-scanner.ts";
import { scanMicroformats } from "#shared/scanners/microformats-scanner.ts";
import { scanOdysee } from "#shared/scanners/odysee-scanner.ts";
import { scanVimeo } from "#shared/scanners/vimeo-scanner.ts";
import { scanXml } from "#shared/scanners/xml-scanner.ts";
import { scanYoutube } from "#shared/scanners/youtube-scanner.ts";

const scanners = [
  scanXml,
  scanHead,
  scanBitchute,
  scanGithub,
  scanHiverss,
  scanOdysee,
  scanVimeo,
  scanYoutube,
  scanGenerator,
  scanLinkFeed,
  scanMicroformats,
];

// Every feed the page itself points at, resolved and without duplicates.
export const scanPage = (address: string, page: ScannerPage): FeedData[] => {
  const feedDataList: FeedData[] = [];
  const addressUrl = new URL(address);
  const seenUrls = new Set<string>();

  for (const scanner of scanners) {
    for (const feedData of scanner(addressUrl, page)) {
      const url = new URL(feedData.url, address).href;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      feedDataList.push({ title: feedData.title, url });
    }
  }

  return feedDataList;
};

// A last resort for a page that advertises nothing: OpenRSS builds feeds for
// some sites that have none. Asking it sends the page address to that third
// party, so each caller decides whether to offer it.
export const openRssSuggestion = (address: string): FeedData => ({
  title: "Attempt to use OpenRSS",
  url: `https://openrss.org/${address.replace(/^https?:\/\//, "")}`,
});
