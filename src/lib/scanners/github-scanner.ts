import { type Scanner } from "./scanner.interface";
import { type FeedData } from "../../types";

export class GithubScanner implements Scanner {
  private static readonly BASE_URL = "https://github.com/";
  private static readonly REPO_PATTERN = new RegExp(
    `^${GithubScanner.BASE_URL}(.+/.+)$`,
  );

  async scan(currentUrl: URL, _document: Document): Promise<FeedData[]> {
    const address = currentUrl.href;

    if (!GithubScanner.isGithubRepoUrl(address)) {
      return [];
    }

    const base = GithubScanner.getBaseRepoUrl(address);
    const repoName = GithubScanner.getRepoName(base) ?? "";

    return [
      {
        url: `${base}/releases.atom`,
        title: `${repoName} - Releases`,
      },
    ];
  }

  private static isGithubRepoUrl(url: string): boolean {
    return GithubScanner.REPO_PATTERN.test(url);
  }

  private static getBaseRepoUrl(url: string): string {
    return url.replace(GithubScanner.REPO_PATTERN, "$1");
  }

  private static getRepoName(url: string): string | null {
    const match = url.match(GithubScanner.REPO_PATTERN);
    return match?.[1] ?? null;
  }
}
