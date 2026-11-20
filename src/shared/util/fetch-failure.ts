interface FetchFailure {
  editable: boolean;
  sentence: string;
  status: number | undefined;
}

const gone = "This feed seems to have moved or been removed.";
const down = "This site isn't responding right now.";

export const httpStatusFailure = (url: string, status: number): string =>
  `Failed to load data for ${url}, received status ${status.toString()}`;

export function classifyFetchFailure(reason: string): FetchFailure {
  const status =
    Number(/received status (\d{3})/u.exec(reason)?.[1]) || undefined;
  if (status === 404 || status === 410)
    return { editable: true, sentence: gone, status };
  if (status === 401 || status === 403 || status === 429)
    return {
      editable: false,
      sentence: "This site is refusing FeedFathom's requests.",
      status,
    };
  if (status) return { editable: false, sentence: down, status };
  if (/ENOTFOUND|EAI_AGAIN/u.test(reason))
    return { editable: true, sentence: "This site can't be found.", status };
  if (
    /ECONN|ETIMEDOUT|EHOSTUNREACH|timed out|socket|certificate|CERT_|TLS|SSL/iu.test(
      reason,
    )
  )
    return { editable: false, sentence: down, status };
  return {
    editable: true,
    sentence: "This address doesn't serve a feed.",
    status,
  };
}
