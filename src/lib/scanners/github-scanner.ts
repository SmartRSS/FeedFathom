import { type FeedData } from "../../types";
import { type Scanner } from "./scanner-interface";

export class GithubScanner implements Scanner {
  private static readonly BASE_URL = "https://github.com/";

  private static readonly REPO_PATTERN = new RegExp(
    `^${GithubScanner.BASE_URL}(.+/.+)$`,
    "u",
  );

  private static getBaseRepoUrl(url: string): string {
    return url.replace(GithubScanner.REPO_PATTERN, "$1");
  }

  private static getRepoName(url: string): null | string {
    const match = url.match(GithubScanner.REPO_PATTERN);
    return match?.[1] ?? null;
  }

  private static isGithubRepoUrl(url: string): boolean {
    return GithubScanner.REPO_PATTERN.test(url);
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
