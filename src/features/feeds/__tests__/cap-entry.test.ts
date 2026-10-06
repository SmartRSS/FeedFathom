import { describe, expect, test } from "bun:test";
import { parseFeed } from "@rowanmanning/feed-parser";
import {
  attachCapAlerts,
  capAlertsById,
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

describe("capAlertsById", () => {
  test("reads the NWS flattened cap:* fields keyed by entry id", async () => {
    const alerts = capAlertsById(await fixture("nws-kansas.xml"));
    expect([...alerts.values()]).toEqual([
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
    expect([...alerts.keys()]).toEqual([
      "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.3d524307b589191dd523bd3b9787af6c7fc8ecf8.001.1",
    ]);
  });

  test("reads MeteoAlarm's non-standard cap:message_type", async () => {
    const alerts = capAlertsById(await fixture("meteoalarm-poland.xml"));
    expect([...alerts.values()].map((alert) => alert.msgType)).toEqual([
      "Alert",
      "Alert",
      "Alert",
    ]);
  });

  test("reads RSS items by guid under any namespace prefix", () => {
    const rss = `<rss xmlns:c="urn:oasis:names:tc:emergency:cap:1.1"><channel>
      <item><guid isPermaLink="false"> g1 </guid><c:event>Ozone</c:event></item>
    </channel></rss>`;
    expect(capAlertsById(rss).get("g1")?.event).toBe("Ozone");
  });

  test("returns nothing for a feed without the CAP namespace", async () => {
    expect(capAlertsById(await fixture("dwd.xml")).size).toBe(0);
  });

  test("returns nothing for CAP-namespaced text that is not well-formed", () => {
    expect(
      capAlertsById(
        '<feed xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><entry>',
      ).size,
    ).toBe(0);
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

  test("a small CAP preview keeps its parsed feed so subscribe can drop alerts expired since", async () => {
    const feed = await parseCapFeed("nws-kansas.xml");
    const preview = mapFeedToPreview(
      feed,
      "https://api.weather.gov/alerts.atom?area=KS&active=1",
      noRewrite,
      fetchedAt,
    );
    expect(preview.truncated).toBe(false);
    expect(preview.feed?.items).toHaveLength(1);
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

  test("an id the parser HTML-decodes", () => {
    expect(
      titlesOf(`<rss version="2.0" xmlns:cap="${capNs}"><channel><title>Alerts</title>
        <item><guid>https://example.com/?region=1&amp;copy=2</guid><title>Drill</title><cap:status>Test</cap:status></item>
      </channel></rss>`),
    ).toEqual([]);
  });
});
