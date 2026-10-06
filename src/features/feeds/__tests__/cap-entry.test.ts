import { describe, expect, test } from "bun:test";
import { parseFeed } from "@rowanmanning/feed-parser";
import {
  attachCapAlerts,
  capAlerts,
  renderCapAlert,
} from "#features/feeds/cap-entry.ts";
import { mapFeedToPreview } from "#features/feeds/feed-mapper.ts";

const casesDir = "src/features/feeds/__tests__/cap-entry-cases";
const fixture = (name: string) => Bun.file(`${casesDir}/${name}`).text();

// The instant the fixtures were fetched. The MeteoAlarm fixture keeps the one
// entry still current then, one already expired, and one expired entry edited
// to status Test with a later expiry, so only its status can hide it.
const fetchedAt = Date.parse("2026-10-06T07:36:00Z");
const noRewrite = (content: string) => content;

const parseCapFeed = async (name: string) => {
  const text = await fixture(name);
  const feed = parseFeed(text);
  attachCapAlerts(text, feed.items);
  return feed;
};

describe("capAlerts", () => {
  test("reads the NWS flattened cap:* fields", async () => {
    expect(capAlerts(await fixture("nws-kansas.xml"))).toEqual([
      {
        areaDesc: "Marshall, KS",
        certainty: "Observed",
        event: "Flood Warning",
        expires: "2026-10-06T10:45:00-05:00",
        msgType: "Update",
        onset: "2026-10-05T19:32:00-05:00",
        severity: "Severe",
        status: "Actual",
        urgency: "Immediate",
      },
    ]);
  });

  test("reads MeteoAlarm's non-standard cap:message_type", async () => {
    const alerts = capAlerts(await fixture("meteoalarm-poland.xml"));
    expect(alerts.map((alert) => alert?.msgType)).toEqual([
      "Alert",
      "Alert",
      "Alert",
    ]);
  });

  test("reads nothing from a feed that only mentions the namespace", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <content type="html">&lt;cap:event xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"&gt;</content>
    </entry></feed>`;
    expect(capAlerts(atom)).toEqual([undefined]);
  });

  test("reads only entries that declare the namespace or inherit it", () => {
    const cap = "urn:oasis:names:tc:emergency:cap:1.2";
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry xmlns:c="${cap}"><c:event>Declared</c:event></entry>
      <entry><c:event xmlns:c="${cap}">Child only</c:event></entry>
    </feed>`;
    expect(capAlerts(atom).map((alert) => alert?.event)).toEqual([
      "Declared",
      undefined,
    ]);
  });

  test("reads RSS items, in order, under any namespace prefix", () => {
    const rss = `<rss xmlns:c="urn:oasis:names:tc:emergency:cap:1.1"><channel>
      <item><title>Plain</title></item>
      <item><title>Ozone</title><c:event>Ozone</c:event></item>
    </channel></rss>`;
    expect(capAlerts(rss).map((alert) => alert?.event)).toEqual([
      undefined,
      "Ozone",
    ]);
  });

  test("returns nothing when entries are spelled two ways, losing their order", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
      <entry><cap:event>One</cap:event></entry>
      <a:entry><cap:event>Two</cap:event></a:entry>
    </feed>`;
    expect(capAlerts(atom)).toEqual([undefined]);
  });

  test("reads only entries that declare the namespace or inherit it", () => {
    const cap = "urn:oasis:names:tc:emergency:cap:1.2";
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry xmlns:c="${cap}"><c:event>Declared</c:event></entry>
      <entry><c:event xmlns:c="${cap}">Child only</c:event></entry>
    </feed>`;
    expect(capAlerts(atom).map((alert) => alert?.event)).toEqual([
      "Declared",
      undefined,
    ]);
  });

  test("returns nothing for a feed without the CAP namespace", async () => {
    expect(capAlerts(await fixture("dwd.xml"))).toEqual([]);
  });

  test("returns nothing for CAP-namespaced text that is not well-formed", () => {
    expect(
      capAlerts(
        '<feed xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><entry>',
      ),
    ).toEqual([]);
  });
});

describe("renderCapAlert", () => {
  test("escapes untrusted alert text", () => {
    const html = renderCapAlert({
      areaDesc: "<img src=x onerror=alert(1)>",
      certainty: "",
      event: "A & B",
      expires: "",
      msgType: "",
      onset: "",
      severity: "",
      status: "Actual",
      urgency: "",
    });
    expect(html).toBe(
      "<dl><dt>Event</dt><dd>A &amp; B</dd><dt>Area</dt><dd>&lt;img src=x onerror=alert(1)&gt;</dd></dl>",
    );
  });
});

describe("CAP feeds through the mapper", () => {
  test("MeteoAlarm shows event, severity and validity and drops expired and Test entries", async () => {
    const feed = await parseCapFeed("meteoalarm-poland.xml");
    const preview = mapFeedToPreview(
      feed,
      "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-poland",
      noRewrite,
      fetchedAt,
    );
    expect(preview.articles.map((article) => article.title)).toEqual([
      "Yellow Wind Warning issued for Poland - Central coastal zone",
    ]);
    expect(preview.truncated).toBe(false);
    const content = preview.articles[0]?.content;
    expect(content).toContain("<dt>Event</dt><dd>Yellow Wind warning</dd>");
    expect(content).toContain("<dt>Severity</dt><dd>Moderate</dd>");
    expect(content).toContain(
      "<dt>Onset</dt><dd>2026-10-05T23:00:00+00:00</dd>",
    );
    expect(content).toContain(
      "<dt>Expires</dt><dd>2026-10-06T09:00:00+00:00</dd>",
    );
  });

  test("an entry is dropped once its expiry passes", async () => {
    const feed = await parseCapFeed("nws-kansas.xml");
    const url = "https://api.weather.gov/alerts.atom?area=KS&active=1";
    expect(
      mapFeedToPreview(feed, url, noRewrite, fetchedAt).articles,
    ).toHaveLength(1);
    expect(
      mapFeedToPreview(feed, url, noRewrite, Date.parse("2026-10-06T15:45:00Z"))
        .articles,
    ).toHaveLength(0);
  });

  test("NWS keeps its summary after the alert details", async () => {
    const feed = await parseCapFeed("nws-kansas.xml");
    const [article] = mapFeedToPreview(
      feed,
      "https://api.weather.gov/alerts.atom?area=KS&active=1",
      noRewrite,
      fetchedAt,
    ).articles;
    expect(article?.content).toStartWith(
      "<dl><dt>Event</dt><dd>Flood Warning</dd>",
    );
    expect(article?.content).toContain("</dl>...The Flood Warning continues");
  });

  test("a feed without CAP maps as before", async () => {
    const text = await fixture("dwd.xml");
    const feed = parseFeed(text);
    attachCapAlerts(text, feed.items);
    const [article] = mapFeedToPreview(
      feed,
      "https://www.dwd.de/DWD/warnungen/cap-feed/de/atom.xml",
      noRewrite,
      fetchedAt,
    ).articles;
    expect(article?.content).toStartWith("Es tritt gebietsweise Nebel");
  });

  test("a preview article carries its alert's expiry for subscribe to check", async () => {
    const feed = await parseCapFeed("nws-kansas.xml");
    const [article] = mapFeedToPreview(
      feed,
      "https://api.weather.gov/alerts.atom?area=KS&active=1",
      noRewrite,
      fetchedAt,
    ).articles;
    expect(article?.expiresAt).toBe(Date.parse("2026-10-06T15:45:00Z"));
  });

  test("CAP text counts toward the preview byte budget", () => {
    const areaDesc = "x".repeat(300 * 1024);
    const entries = ["a", "b", "c"]
      .map(
        (id) =>
          `<entry><id>${id}</id><title>${id}</title><cap:areaDesc>${areaDesc}</cap:areaDesc></entry>`,
      )
      .join("");
    expect(
      titlesOf(
        `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="${capNs}"><title>Alerts</title>${entries}</feed>`,
      ),
    ).toEqual(["a"]);
  });
});

const capNs = "urn:oasis:names:tc:emergency:cap:1.2";
const titlesOf = (xml: string) => {
  const feed = parseFeed(xml);
  attachCapAlerts(xml, feed.items);
  return mapFeedToPreview(
    feed,
    "https://example.com/feed",
    noRewrite,
    fetchedAt,
  ).articles.map((article) => article.title);
};

describe("CAP entries the feed parser reads its own way", () => {
  test("a prefixed Atom feed", () => {
    expect(
      titlesOf(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:cap="${capNs}">
        <atom:title>Alerts</atom:title>
        <atom:entry><atom:id>a</atom:id><atom:title>Actual</atom:title><cap:status>Actual</cap:status></atom:entry>
        <atom:entry><atom:id>b</atom:id><atom:title>Drill</atom:title><cap:status>Test</cap:status></atom:entry>
      </atom:feed>`),
    ).toEqual(["Actual"]);
  });

  test("entries that declare the CAP namespace under different prefixes", () => {
    expect(
      titlesOf(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Alerts</title>
        <entry xmlns:c="${capNs}"><id>a</id><title>Actual</title><c:status>Actual</c:status></entry>
        <entry xmlns:cap="${capNs}"><id>b</id><title>Drill</title><cap:status>Test</cap:status></entry>
      </feed>`),
    ).toEqual(["Actual"]);
  });

  test("a cap prefix rebound to another namespace is not CAP", () => {
    expect(
      titlesOf(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="${capNs}"><title>Alerts</title>
        <entry xmlns:cap="https://example.com/other"><id>a</id><title>Other</title><cap:status>Test</cap:status></entry>
      </feed>`),
    ).toEqual(["Other"]);
  });

  test("RSS items without a guid", () => {
    expect(
      titlesOf(`<rss version="2.0" xmlns:cap="${capNs}"><channel><title>Alerts</title>
        <item><title>Drill</title><link>https://example.com/1</link><cap:status>Test</cap:status></item>
        <item><title>Ozone</title><link>https://example.com/2</link><cap:event>Ozone</cap:event></item>
      </channel></rss>`),
    ).toEqual(["Ozone"]);
  });

  test("an id the parser HTML-decodes", () => {
    expect(
      titlesOf(`<rss version="2.0" xmlns:cap="${capNs}"><channel><title>Alerts</title>
        <item><guid>https://example.com/?region=1&amp;copy=2</guid><title>Drill</title><cap:status>Test</cap:status></item>
      </channel></rss>`),
    ).toEqual([]);
  });
});
