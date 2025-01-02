import type { Scanner } from "./scanners/scanner.interface";
import { XmlScanner } from "./scanners/xml-scanner";
import { HeadScanner } from "./scanners/head-scanner";
import { BitchuteScanner } from "./scanners/bitchute-scanner";
import { GithubScanner } from "./scanners/github-scanner";
import { HiveblogScanner } from "./scanners/hiveblog-scanner";
import { OdseeScanner } from "./scanners/odsee-scanner";
import { SteemitScanner } from "./scanners/steemit-scanner";
import { VimeoScanner } from "./scanners/vimeo-scanner";
import { YoutubeScanner } from "./scanners/youtube-scanner";
import { GeneratorScanner } from "./scanners/generator-scanner";
import { type FeedData } from "../types";

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
];

export async function scan(address: string, document: Document) {
  const feedDataList: FeedData[] = [];
  const addressUrl = new URL(address);

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
    feedDataList.push(
      ...result.map((feedData) => {
        return {
          title: feedData.title,
          url: new URL(feedData.url, address).href,
        };
      }),
    );
  }

  if (feedDataList.length === 0) {
    feedDataList.push({
      url: `https://openrss.org/${address}`,
      title: "Attempt to use OpenRSS",
    });
  }

  return feedDataList;
}
