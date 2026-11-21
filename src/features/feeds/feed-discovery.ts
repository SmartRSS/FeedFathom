import type { FeedData } from "#shared/scanners/feed-data-type.ts";

type DiscoveredFeed = FeedData & { websub: boolean };

export type WebSubProbe = {
  parseUrl(
    url: string,
    options?: { metadataOnly?: boolean },
  ): Promise<{ websub?: unknown }>;
};

export async function markWebSubAvailability(
  feeds: readonly FeedData[],
  probe: WebSubProbe,
): Promise<DiscoveredFeed[]> {
  const discovered: DiscoveredFeed[] = [];
  /* eslint-disable no-await-in-loop -- Each probe waits for the host the previous one used. */
  for (const feed of feeds) {
    let websub = false;
    try {
      websub =
        (await probe.parseUrl(feed.url, { metadataOnly: true })).websub !==
        undefined;
    } catch {}
    discovered.push({ title: feed.title, url: feed.url, websub });
  }
  /* eslint-enable no-await-in-loop */
  return discovered;
}
