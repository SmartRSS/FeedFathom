import { expect, test } from "bun:test";
import { openRssSuggestion } from "../scanner.ts";

test("the OpenRSS suggestion names the page without its scheme", () => {
  expect(openRssSuggestion("https://site.example/blog?page=2")).toEqual({
    title: "Attempt to use OpenRSS",
    url: "https://openrss.org/site.example/blog?page=2",
  });
});
