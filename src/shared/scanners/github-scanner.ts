import type { ScannerPage } from "#shared/scanners/scanner-page.ts";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";

const sitePaths = new Set([
  "about",
  "account",
  "apps",
  "blog",
  "business",
  "codespaces",
  "collections",
  "contact",
  "copilot",
  "customer-stories",
  "dashboard",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "password_reset",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "sessions",
  "settings",
  "signup",
  "site",
  "solutions",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

export const scanGithub = (currentUrl: URL, _page: ScannerPage): FeedData[] => {
  if (
    currentUrl.hostname !== "github.com" ||
    (currentUrl.protocol !== "https:" && currentUrl.protocol !== "http:")
  ) {
    return [];
  }

  const [, owner, repository] = currentUrl.pathname.split("/");
  if (
    !owner ||
    !repository ||
    sitePaths.has(owner.toLowerCase()) ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(owner) ||
    !/^[\w.-]{1,100}$/u.test(repository)
  ) {
    return [];
  }

  const repoName = `${owner}/${repository}`;
  return [
    {
      title: `${repoName} - Releases`,
      url: `https://github.com/${repoName}/releases.atom`,
    },
  ];
};
