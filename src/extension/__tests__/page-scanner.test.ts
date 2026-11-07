import { describe, expect, test } from "bun:test";
import type { FeedData } from "#shared/scanners/feed-data-type.ts";
import type { ListFeedsMessage, VisibilityLostMessage } from "../messages.ts";
import {
  createPageScanner,
  scanDebounceMs,
  visibilityDebounceMs,
} from "../page-scanner.ts";
import { fakeSchedule } from "./fake-schedule.ts";

// A page whose address and feeds the test changes, with scans that finish
// when the test says so.
const fakePage = () => {
  const clock = fakeSchedule();
  const page = { hidden: false, href: "https://site.example/a" };
  const sent: (ListFeedsMessage | VisibilityLostMessage)[] = [];
  const scans = new Map<string, (feeds: FeedData[]) => void>();
  const scanner = createPageScanner({
    hidden: () => page.hidden,
    href: () => page.href,
    scan: (href) =>
      new Promise((resolve) => {
        scans.set(href, resolve);
      }),
    schedule: clock.schedule,
    send: (message) => sent.push(message),
  });
  const finishScan = async (href: string, feeds: FeedData[]) => {
    scans.get(href)?.(feeds);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const reportedTitles = () =>
    sent.map((message) =>
      message.action === "list-feeds"
        ? message.feedsData.map((feed) => feed.title)
        : message.action,
    );
  return { clock, finishScan, page, reportedTitles, scanner };
};

const feed = (title: string) => ({
  title,
  url: `https://site.example/${title}`,
});

describe("createPageScanner", () => {
  test("reports the page's feeds once the report debounce passes", async () => {
    const { clock, finishScan, reportedTitles, scanner } = fakePage();
    scanner.start();
    await finishScan("https://site.example/a", [feed("A")]);
    expect(reportedTitles()).toEqual([]);
    clock.advance(visibilityDebounceMs);
    expect(reportedTitles()).toEqual([["A"]]);
  });

  test("a hidden page reports visibility-lost at once", () => {
    const { page, reportedTitles, scanner } = fakePage();
    page.hidden = true;
    scanner.report();
    expect(reportedTitles()).toEqual(["visibility-lost"]);
  });

  test("an address change clears the feeds and rescans after the debounce", async () => {
    const { clock, finishScan, page, reportedTitles, scanner } = fakePage();
    scanner.start();
    await finishScan("https://site.example/a", [feed("A")]);
    clock.advance(visibilityDebounceMs);

    page.href = "https://site.example/b";
    scanner.rescanIfHrefChanged();
    clock.advance(visibilityDebounceMs);
    expect(reportedTitles()).toEqual([["A"], []]);

    clock.advance(scanDebounceMs - visibilityDebounceMs);
    await finishScan("https://site.example/b", [feed("B")]);
    clock.advance(visibilityDebounceMs);
    expect(reportedTitles()).toEqual([["A"], [], ["B"]]);
  });

  test("a scan that ends after the address moved on is dropped", async () => {
    const { clock, finishScan, page, reportedTitles, scanner } = fakePage();
    page.href = "https://site.example/stale";
    scanner.rescanIfHrefChanged();
    clock.advance(scanDebounceMs);

    page.href = "https://site.example/latest";
    scanner.rescanIfHrefChanged();
    await finishScan("https://site.example/stale", [feed("Stale")]);
    clock.advance(scanDebounceMs);
    await finishScan("https://site.example/latest", [feed("Latest")]);
    clock.advance(visibilityDebounceMs);

    expect(reportedTitles().flat()).not.toContain("Stale");
    expect(reportedTitles().at(-1)).toEqual(["Latest"]);
  });

  test("a mutation that keeps the address sends nothing", async () => {
    const { clock, finishScan, reportedTitles, scanner } = fakePage();
    scanner.start();
    await finishScan("https://site.example/a", [feed("A")]);
    clock.advance(visibilityDebounceMs);

    scanner.rescanIfHrefChanged();
    clock.advance(scanDebounceMs + visibilityDebounceMs);
    expect(reportedTitles()).toEqual([["A"]]);
  });
});
