import type { FeedData } from "../../types.ts";
import type { Scanner } from "./scanner-interface.ts";
const baseUrl = "https://github.com/" as const;

const repoPattern = new RegExp(`^${baseUrl}(.+/.+)$`, "u");

export class GithubScanner implements Scanner {
  private static getBaseRepoUrl(url: string): string {
    return url.replace(repoPattern, "$1");
  }

  private static getRepoName(url: string): null | string {
    const match = url.match(repoPattern);
    return match?.[1] ?? null;
  }

  private static isGithubRepoUrl(url: string): boolean {
    return repoPattern.test(url);
  }

  scan(currentUrl: URL, _document: Document): FeedData[] {
    const address = currentUrl.href;

    if (!GithubScanner.isGithubRepoUrl(address)) {
      return [];
    }

    const base = GithubScanner.getBaseRepoUrl(address);
    const repoName = GithubScanner.getRepoName(base) ?? "";

    return [
      {
        title: `${repoName} - Releases`,
        url: `${base}/releases.atom`,
      },
    ];
  }
}
