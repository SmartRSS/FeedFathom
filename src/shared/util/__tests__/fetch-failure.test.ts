import { expect, test } from "bun:test";
import {
  classifyFetchFailure,
  describeFetchFailure,
} from "#shared/util/fetch-failure.ts";

const status = (code: number) =>
  `Failed to load data for https://example.com/feed.xml, received status ${code}`;

// One row per cause a reader is told about: the reasons are the fetcher's own
// words, as sources.recent_failure_details stores them.
test.each([
  [
    "feed gone",
    [status(404), status(410)],
    "This feed seems to have moved or been removed.",
    true,
  ],
  [
    "site not found",
    ["getaddrinfo ENOTFOUND feed.example", "getaddrinfo EAI_AGAIN x"],
    "This site can't be found.",
    true,
  ],
  [
    "not a feed",
    ["", "XML Parse error: Expected the root element", "Not a feed"],
    "This address doesn't serve a feed.",
    true,
  ],
  [
    "site refusing",
    [status(401), status(403), status(429)],
    "This site is refusing FeedFathom's requests.",
    false,
  ],
  [
    "site down",
    [
      status(500),
      status(503),
      status(400),
      "connect ECONNREFUSED 1.2.3.4:443",
      "The request timed out",
      "unable to verify the first certificate",
    ],
    "This site isn't responding right now.",
    false,
  ],
])("%s", (_cause, reasons, sentence, editable) => {
  for (const reason of reasons) {
    expect(classifyFetchFailure(reason)).toMatchObject({ editable, sentence });
    expect(describeFetchFailure(reason)).toBe(sentence);
  }
});

test("keeps the HTTP status for the details, and only that", () => {
  expect(classifyFetchFailure(status(410)).status).toBe(410);
  expect(
    classifyFetchFailure("getaddrinfo ENOTFOUND x").status,
  ).toBeUndefined();
});
