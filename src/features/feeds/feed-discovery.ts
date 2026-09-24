import type { FeedData } from "#shared/scanners/feed-data-type.ts";

/**
 * A feed found on a page, with whether it advertises a WebSub hub.
 */
export type DiscoveredFeed = FeedData & { websub: boolean };

/**
 * The one thing discovery needs from a parser: does this feed push?
 *
 * Deliberately narrower than FeedParser["parseUrl"], which returns the whole
 * parsed feed. Discovery reads a single boolean off it, and a dependency that
 * says so keeps the test doubles to that boolean.
 */
export type WebSubProbe = {
  parseUrl(url: string): Promise<{ websub?: unknown }>;
};

/**
 * Mark each candidate with whether it advertises a WebSub hub.
 *
 * Every candidate is fetched through the normal cached and rate-limited parse
 * pipeline rather than a bare request, because the discovery list wants to show
 * push availability before the user commits to subscribing.
 *
 * A candidate whose parse fails -- a dead link, or the OpenRSS placeholder the
 * scanner falls back to -- comes back unmarked rather than being dropped. The
 * failure surfaces anyway when the user clicks through to preview it, and
 * dropping it here would make the page look like the feed never existed.
 *
 * Candidates are probed one at a time, in the order they were found. They
 * usually share a host, and probed together they queue on its rate limit,
 * where one whose turn does not come inside its deadline fails like a dead
 * feed and reads as having no hub. One at a time, a failed probe means the
 * feed failed.
 */
export async function markWebSubAvailability(
  feeds: readonly FeedData[],
  probe: WebSubProbe,
): Promise<DiscoveredFeed[]> {
  const discovered: DiscoveredFeed[] = [];
  /* eslint-disable no-await-in-loop -- Each probe waits for the host the previous one used. */
  for (const feed of feeds) {
    let websub = false;
    try {
      websub = (await probe.parseUrl(feed.url)).websub !== undefined;
    } catch {
      // Unmarked, not dropped -- see above.
    }
    discovered.push({ title: feed.title, url: feed.url, websub });
  }
  /* eslint-enable no-await-in-loop */
  return discovered;
}
