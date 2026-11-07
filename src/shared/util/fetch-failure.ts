// The fetcher stores and reports failures in its own words ("Failed to load
// data for <url>, received status 404", "getaddrinfo ENOTFOUND"). This sorts
// one into the few causes a reader can tell apart and act on, each with a
// plain sentence. The URL and the status stay out of the sentence: wherever
// it shows, the feed is already named, and the status is for an admin's
// details. `editable` marks the causes a new address can fix.
interface FetchFailure {
  editable: boolean;
  sentence: string;
  status: number | undefined;
}

const gone = "This feed seems to have moved or been removed.";
const down = "This site isn't responding right now.";

// The reason the fetcher stores for an answer other than 200. Stored reasons
// outlive a deploy, so the wording is part of what classifyFetchFailure reads.
export const httpStatusFailure = (url: string, status: number): string =>
  `Failed to load data for ${url}, received status ${status.toString()}`;

export function classifyFetchFailure(reason: string): FetchFailure {
  const status =
    Number(/received status (\d{3})/u.exec(reason)?.[1]) || undefined;
  if (status === 404 || status === 410)
    return { editable: true, sentence: gone, status };
  // A site that wants a login, blocks the fetcher or rate-limits it: the
  // address is right, so a new one won't help.
  if (status === 401 || status === 403 || status === 429)
    return {
      editable: false,
      sentence: "This site is refusing FeedFathom's requests.",
      status,
    };
  // Any other error status is the site's own trouble, and the address may
  // well be right.
  if (status) return { editable: false, sentence: down, status };
  if (/ENOTFOUND|EAI_AGAIN/u.test(reason))
    return { editable: true, sentence: "This site can't be found.", status };
  if (
    /ECONN|ETIMEDOUT|EHOSTUNREACH|timed out|socket|certificate|CERT_|TLS|SSL/iu.test(
      reason,
    )
  )
    return { editable: false, sentence: down, status };
  // It answered, with something that isn't a feed.
  return {
    editable: true,
    sentence: "This address doesn't serve a feed.",
    status,
  };
}
