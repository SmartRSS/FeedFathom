import { expect, test } from "bun:test";
import { describeFetchFailure } from "#shared/util/fetch-failure.ts";

test("names the HTTP status the server answered with", () => {
  expect(
    describeFetchFailure(
      "Failed to load data for https://example.com/feed.xml, received status 404",
    ),
  ).toBe("The server answered 404 (not found).");
  expect(
    describeFetchFailure("Failed to load data for x, received status 418"),
  ).toBe("The server answered 418.");
});

test("tells an unknown host from one that does not answer", () => {
  expect(describeFetchFailure("getaddrinfo ENOTFOUND feed.example")).toBe(
    "The server could not be found.",
  );
  expect(describeFetchFailure("connect ECONNREFUSED 1.2.3.4:443")).toBe(
    "The server could not be reached.",
  );
});

test("falls back to a plain sentence for anything else", () => {
  for (const reason of ["", "XML Parse error: Expected the root element"])
    expect(describeFetchFailure(reason)).toBe(
      "The address did not return a readable feed.",
    );
});
