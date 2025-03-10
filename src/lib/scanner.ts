import { type FeedData } from "../types";
import { BitchuteScanner } from "./scanners/bitchute-scanner";
import { GeneratorScanner } from "./scanners/generator-scanner";
import { GithubScanner } from "./scanners/github-scanner";
import { HeadScanner } from "./scanners/head-scanner";
import { HiveblogScanner } from "./scanners/hiveblog-scanner";
import { LinkFeedScanner } from "./scanners/link-feed-scanner";
import { OdseeScanner } from "./scanners/odsee-scanner";
import { type Scanner } from "./scanners/scanner-interface";
import { SteemitScanner } from "./scanners/steemit-scanner";
import { VimeoScanner } from "./scanners/vimeo-scanner";
import { XmlScanner } from "./scanners/xml-scanner";
import { YoutubeScanner } from "./scanners/youtube-scanner";

const scanners: Scanner[] = [
  new XmlScanner(),
  new HeadScanner(),
  new BitchuteScanner(),
  new GithubScanner(),
  new HiveblogScanner(),
  new OdseeScanner(),
  new SteemitScanner(),
  new VimeoScanner(),
  new YoutubeScanner(),
  new GeneratorScanner(),
  new LinkFeedScanner(),
];

export const scan = async (address: string, document: Document) => {
  const feedDataList: FeedData[] = [];
  const addressUrl = new URL(address);
  const seenUrls = new Set<string>();

  const results = await Promise.all(
    scanners.map((scanner) => {
      return scanner.scan(addressUrl, document);
      // Each scanner is expected to check applicability for the given address or document.
      // If the address is not relevant (e.g., wrong platform or unsupported content),
      // the scanner should early exit (return []) without performing unnecessary computation
      // or network requests. This ensures efficient resource usage and scalability as more scanners are added.
    }),
  );

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
    feedDataList.push({
      title: "Attempt to use OpenRSS",
      url: `https://openrss.org/${address}`,
    });
  }

  return feedDataList;
};
