// The fetcher stores and reports failures in its own words ("Failed to load
// data for <url>, received status 404", "getaddrinfo ENOTFOUND"). This puts
// one into a sentence a reader can act on. The URL stays out: wherever the
// sentence shows, the feed is already named.
const statusNames: Record<number, string> = {
  401: "login required",
  403: "forbidden",
  404: "not found",
  410: "gone",
  429: "too many requests",
  500: "server error",
  502: "bad gateway",
  503: "unavailable",
  504: "gateway timeout",
};

export function describeFetchFailure(reason: string): string {
  const status = /received status (\d{3})/u.exec(reason)?.[1];
  if (status) {
    const name = statusNames[Number(status)];
    return `The server answered ${status}${name ? ` (${name})` : ""}.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/u.test(reason))
    return "The server could not be found.";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|timed out/iu.test(reason))
    return "The server could not be reached.";
  return "The address did not return a readable feed.";
}
