# CAP and DATEX II in FeedFathom

Research note, 2026-10-06. Endpoints marked "verified live on 2026-10-06" were
fetched with `curl` on that date. Anything not fetched or not confirmed in a
primary source is marked **unverified**.

## TL;DR

1. CAP alerts already reach users as ordinary Atom/RSS index feeds (NWS, MeteoAlarm, DWD, Environment Canada NAAD, FEMA IPAWS, EA flood). FeedFathom parses all of them today. It ignores the `cap:*` elements.
2. The real gaps are expired alerts staying in the list (405 of 406 MeteoAlarm Poland entries had already expired), empty bodies on link-only feeds, and no area filtering.
3. DATEX II is a machine-to-machine exchange of multi-MB snapshots, often behind registration. No publisher checked exposes it as RSS/Atom. It does not fit a feed reader.
4. Recommendation: (a) document working feed URLs now (~1 h). (b) Then, only if users ask, render `cap:*` and drop expired or test entries (~6–8 h). Skip DATEX II.

## 1. CAP (OASIS Common Alerting Protocol 1.2)

### Spec essentials

Source: [CAP v1.2, OASIS Standard](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html).

- Structure: `alert` (one message), with zero or more `info` blocks (one per language or audience), each with zero or more `area` blocks ([§3.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)).
- `msgType` is one of `Alert`, `Update`, `Cancel`, `Ack`, `Error`. `Update` "updates and supercedes the earlier message(s) identified in `<references>`". `Cancel` cancels them ([§3.2.1](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)).
- `references` holds whitespace-separated `sender,identifier,sent` triples ([§3.2.1](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)). An Update is a **new message with a new identifier**. It does not edit the old message.
- `sent` is required. `expires` is optional and sits in `info` ([§3.2.1–3.2.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)).
- `urgency`: Immediate, Expected, Future, Past, Unknown. `severity`: Extreme, Severe, Moderate, Minor, Unknown. `certainty`: Observed, Likely, Possible, Unlikely, Unknown ([§3.2.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)).
- `area/polygon` is a closed ring of at least 4 WGS 84 `lat,lon` pairs. `area/geocode` holds `valueName`/`value` pairs such as SAME, UGC or EMMA_ID ([§3.2.4](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)).
- The spec defines no transport. It does not mention Atom or RSS ([CAP 1.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)).

### The CAP-over-Atom convention

- OASIS [CAP Feeds v1.0 Committee Note (2014)](https://docs.oasis-open.org/emergency-adopt/cap-feeds/v1.0/cap-feeds-v1.0.html) recommends that each entry **link** to the full CAP document (`type="application/cap+xml"`) rather than embed it (§2.3). It also recommends:
  - a new entry for each Update rather than editing the old entry (§2.6);
  - removing cancelled, updated or expired alerts, optionally after 24–48 h (§2.6);
  - a tag URI or UUID as entry id, because CAP identifiers can collide (§2.3.1.2);
  - public feeds that carry only `scope=Public`, `status=Actual` (§2.1).
- Google Public Alerts accepts Atom, RSS or EDXL-DE, and requires a link to the full CAP alert. It sets a 900 KB maximum feed size and recommends 100 KB ([feed formats](https://developers.google.com/public-alerts/guides/cap-requirements/feed-formats)). Whether Google still ingests these feeds is **unverified**. The page shows no deprecation notice.
- In practice, publishers do both. Some embed a flattened copy of `cap:*` fields in the entry **and** link the CAP XML (NWS, MeteoAlarm). Others only link it (DWD, EA, FEMA). See the table.
- WMO's Alert Hub lists about 231 alerting-authority sources. Each source has a `capAlertFeed` URL and a status ([sources JSON](https://alert-hub-sources.s3.amazonaws.com/json), verified live on 2026-10-06). It is a usable directory of feed URLs. The NWS entry in that directory (`/alerts/active.atom?region_type=land`) returned **HTTP 400** on 2026-10-06, so the directory is partly stale.

### Publishers (verified live on 2026-10-06 unless marked)

| Publisher | Feed URL | Shape | Size / entries | Auth |
| --- | --- | --- | --- | --- |
| NWS (US) | `https://api.weather.gov/alerts.atom?area=KS&active=1` | Atom index, embeds flattened `cap:*` (event, sent, expires, msgType, severity, polygon, geocode, parameters), `link rel=alternate` → `.cap` XML | KS: 6.5 KB / 1 entry; national: 1.4 MB / 337 entries | User-Agent required ([NWS API](https://www.weather.gov/documentation/services-web-api)) |
| MeteoAlarm (Europe, one feed per country) | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-poland` | Atom, embeds `cap:*` (uses non-standard `cap:message_type`), **no summary/content**, link `type=application/cap+xml` | Poland: 650 KB / 406 entries, **405 already expired** | none; CC BY 4.0 with extra terms |
| DWD (DE) | `https://www.dwd.de/DWD/warnungen/cap-feed/de/atom.xml` (also `/rss.xml`, `/en/`) | Atom, plain text summary, link `rel=related type=application/cap+xml`. No `cap:*` | 18.5 KB / 15 entries | none; "public domain" |
| Environment Canada NAAD (Pelmorex) | `https://rss.naad-adna.pelmorex.com/` | Atom (CAP **1.1** ns), summary HTML, `georss:polygon`, CAP fields as `category term="severity=…"`, link → CAP XML | 707 KB / ~200 entries, 24 `status=Test` | none |
| FEMA IPAWS | `https://apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest/feed` | Atom, title is a 3-letter EAS event code only, link → CAP | 1.2 KB / 3 entries | none |
| Environment Agency (England) | `https://environment.data.gov.uk/cap/flood-alerts.atom` | Atom, title is an area code (`054WATBT2`), no summary, link → CAP | 1.3 KB / 2 entries | none; CC BY 4.0 |
| NOAA tsunami | `https://www.tsunami.gov/events/xml/PAAQAtom.xml` | Atom, rich XHTML summary, `geo:lat/long` (redirects from the non-www host) | 2 KB | none |
| AirNow / EPA | `https://feeds.enviroflash.info/cap/aggregate.xml` | Atom with `cap:*` | 63 KB / 23 entries | none |
| ECCC Datamart | `https://dd.weather.gc.ca/today/alerts/cap/` | Directory listing of raw CAP files by office. **Not a feed** | — | none |
| IMGW (PL) | no native CAP feed found. Its CAP reaches users through MeteoAlarm (`sender` = `https://www.imgw.pl`). Its own [JSON/XML API](https://danepubliczne.imgw.pl/api/data/warningsmeteo) is not CAP | — | none |
| RCB (PL) | `rcb.gov.pl/feed/` redirects to an HTML page. No CAP or RSS found (**unverified** whether one exists) | — | — |

Related observations:

- NWS caching: `cache-control: max-age=5`, weak ETag. FeedFathom's 5-minute floor (`pollFloorMs` in `src/features/feeds/source-schedule-policy.ts`) applies, so the 30 s polling limit in the [NWS alerts docs](https://www.weather.gov/documentation/services-web-alerts) is never at risk.
- MeteoAlarm advertises a WebSub hub (`pubsubhubbub.appspot.com`). FeedFathom subscribes to WebSub hubs.
- MeteoAlarm retired its legacy RSS feeds on 2026-01-14 and points users to the Atom feeds ([feeds.meteoalarm.org](https://feeds.meteoalarm.org/), verified live).
- Area filters on the publisher side: NWS supports `area`, `zone`, `point` and `region` ([NWS alerts docs](https://www.weather.gov/documentation/services-web-alerts)). With FeedFathom's Accept header, `alerts.atom?area=…&active=1` and `alerts.atom?point=…&active=1` return Atom on 2026-10-06, but `alerts.atom?zone=…&active=1` redirects to `/alerts/active/zone/…` and returns GeoJSON; `/alerts/active.atom?zone=…` returns 400 and `/alerts/active/zone/….atom` returns 404. No zone form that returns Atom was found. MeteoAlarm and DWD publish one feed per country, so a user who wants alerts for a smaller area needs filtering inside the reader.

### How FeedFathom handles these feeds today (tested 2026-10-06)

The test ran `@rowanmanning/feed-parser` (the parser `src/features/feeds/feed-parser.ts` calls) on the fetched files:

- **All four (NWS, MeteoAlarm, NAAD, DWD) parse.** Titles are good.
- **NWS URL trap.** FeedFathom sends `accept: application/rss+xml, application/atom+xml, …, application/json, …` (`src/platform/http/http-client.ts`). With that header, `api.weather.gov/alerts/active?area=KS` returns **GeoJSON**, which does not parse as a feed. The URL that works is `https://api.weather.gov/alerts.atom?area=KS&active=1`, because the `.atom` path does not depend on content negotiation. `/alerts/active.atom?area=…` returns 400.
- **NWS article link** is the raw `.cap` XML. A click opens XML, not a web page.
- **MeteoAlarm, EA and FEMA bodies are empty**, because the feeds have no summary. All the meaning is in `cap:*`, which the parser drops. The parser keeps its XML element private (`#element`), so FeedFathom cannot reach `cap:*` through it.
- **NAAD bilingual collision.** Each alert appears once per language under the **same `<id>`** (en-CA, then fr-CA). `batchUpsertArticles` dedupes on `(sourceId, guid)` and keeps the last copy (`src/features/feeds/article-data-service.ts`), so only the French copy is stored. NAAD entries also have no `<published>`, so `publishedAt` falls back to fetch time (`feed-mapper.ts`).
- **Expiry is ignored.** An expired entry stays in the list as long as the publisher keeps it in the feed. MeteoAlarm keeps expired entries (405 of 406 on 2026-10-06). After an entry leaves the feed, gone-from-feed retention removes it only once it has been absent ≥24 h **and** every subscriber who could have seen it has deleted it; reading does not count (`src/features/feeds/retention.ts`). Otherwise only the dormant-subscriber rule removes it.
- **Superseded and cancelled alerts stay.** Each Update is a new entry with a new id, and the superseded entry drops out of the feed. NWS, for example, lists the superseded ids in `cap:parameter expiredReferences`, and the old entry is no longer in the active feed. In FeedFathom, an Update becomes a new unread article. The old article stays until every subscriber who could have seen it deletes it (or all of them go dormant), so an active reader who keeps it keeps it indefinitely. CAP Feeds §2.6 prescribes this append model for publishers; for a reader it means stale alerts linger unless the user deletes them.

### Mapping one alert to one article

The mapping works for NWS, DWD and tsunami. It fails in three places:

1. MeteoAlarm has one entry per (alert × area) and the same event repeats across regions (404 "Yellow Fog warning" entries in one Poland snapshot).
2. NAAD has one entry per language with a shared id.
3. Without an area filter, a country-wide feed is noise. An unread count of 406 for Polish fog is not a useful signal.

## 2. DATEX II

### What it models and how it moves

- DATEX II is the CEN EN 16157 series. It models road situations (`SituationPublication` → `situation` → `situationRecord`, with typed records such as Accident, RoadOrCarriagewayOrLaneManagement and AbnormalTraffic), traffic measurements, travel times, VMS, parking and more ([DATEX II docs: Situation](https://docs.datex2.eu/levels/mastering/situation/)).
- Version 3 split the content model from the exchange layer, and introduced per-topic namespaces ([v2.3 → v3 conversion](https://docs.datex2.eu/user-guide/Conversionv2_v3/)). The rename of `D2LogicalModel` to `D2Payload` is **unverified** (the former source, repo.datex2.eu, no longer resolves). The current release is 3.7 ([DATEX II docs, Version 3.7](https://docs.datex2.eu/downloads/modelv37/), verified live on 2026-10-06); 3.6 was announced 2025-06-11 ([datex2.eu](https://datex2.eu/2025/06/11/now-available-datex-ii-version-3-6/)). DGT already serves 3.7 (below).
- Exchange: v2.3 used HTTP GET pull or snapshot pull. "Exchange 2020" defines SOAP web services for snapshot pull, snapshot push, simple push and stateful push ([DATEX II docs, Exchange 2020](https://docs.datex2.eu/v3.3/exchange/2020/information-delivery/index.html)). In practice most open data is a gzipped XML file over plain HTTP.
- Regulation: Delegated Regulation (EU) [2022/670](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R0670) replaces [2015/962](https://eur-lex.europa.eu/eli/reg_del/2015/962/oj). It requires real-time traffic data on National Access Points in DATEX II, and widens the scope from TEN-T to the whole network in phases ([EC RTTI page](https://transport.ec.europa.eu/transport-themes/smart-mobility/road/its-directive-and-action-plan/safety-related-traffic-information-srti-real-time-traffic-information-rtti_en)). EUR-Lex blocked direct fetching, so the exact article wording is **unverified**.

### Publishers

| Publisher | What was checked | Finding |
| --- | --- | --- |
| NDW (NL) | [opendata.ndw.nu](https://opendata.ndw.nu/), verified live | Open, no auth. `actueel_beeld.xml.gz`: 372 KB gz / **4.4 MB XML**, DATEX II v3, 1193 situations / 1506 records, regenerated about every minute (Last-Modified tracks it). Other files run to 15 MB gz (road works) and 236 MB (traffic signs). v2.3 travel-time files end 2027-02-09 (notice on the portal). |
| DGT (ES) | `https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v36.xml`, verified live | Open. Redirects to `datex2_v37.xml`. **8.1 MB** uncompressed. The filename follows the version, so a pinned URL breaks on each version change. |
| Fintraffic Digitraffic (FI) | `https://tie.digitraffic.fi/api/traffic-message/v1/messages.datex2`, verified live | Open, no key ([Digitraffic road](https://www.digitraffic.fi/en/road-traffic/)). Small (about 4 KB gz for active announcements). Also offers a GeoJSON "Simple JSON" variant. DATEX II 3.7 / 3.5 / 2.2.3. |
| GDDKiA (PL) | [KPD DATEX profile](https://kpd.gddkia.gov.pl/index.php/en/profile-datex/) | DATEX II 3.4 via the KPD interface. The page links to registration, so registration looks required (**unverified**). Separately, `https://www.archiwum.gddkia.gov.pl/dane/zima_html/utrdane.xml` (verified live) is an open **custom-schema** XML file of 498 obstructions, 530 KB ([GDDKiA dane xml](https://www.gov.pl/web/gddkia/dane-xml)). It is not DATEX. |
| Trafikverket (SE) | [Trafiklab](https://www.trafiklab.se/api/other-apis/trafikverket/) | API key required. Uses a POST query API (`Situation` object). A separate DATEX II service exists at data.trafikverket.se (**unverified**, search result only). |
| National Highways (UK) | NTIS publish services (the former overview PDF at trafficengland.com now redirects to a 404) | Free but **registration required**. DATEX II is **pushed** to the subscriber's server (search-result summary). The subscribers page now returns 404. **Unverified.** |
| BASt / Mobilithek (DE) | not fetched | Commonly described as subscription-based. **Unverified.** |

**RSS/Atom of DATEX II: none found.** No checked publisher offers DATEX II as RSS or Atom, and the standard defines no syndication binding. The human-facing traffic feeds checked do not cover incidents either. Traffic Scotland's `https://www.traffic.gov.scot/rss.xml` (verified live) carries 4 news items, and the legacy incidents RSS returns 404.

### Fit with a feed reader

DATEX II does not fit:

- **Format:** snapshots replace the whole state (4–8 MB of XML every minute for one country). They are not an append stream.
- **No text:** records are coded enums plus location references (ALERT-C, linear references, GML), with human text only sometimes present (114 `generalPublicComment` in 1506 NDW records).
- **Location:** making the data useful needs geometry and road-network filtering.
- **Access:** several national publishers need registration, keys or push endpoints.
- **Volume is not the barrier.** The 4.4 MB NDW and 8.1 MB DGT snapshots fit under FeedFathom's 24 MiB response limit (`maximumBodyBytes` in `src/platform/http/http-cache-store.ts`). The barriers are the snapshot-replace semantics and the coded, text-poor content above.

## 3. Fit with FeedFathom

What a user would realistically subscribe to:

- their national weather-warning Atom (DWD, MeteoAlarm for their country);
- NWS for their state or a point (`alerts.atom?area=` or `?point=`);
- NAAD;
- perhaps EA flood alerts.

All of these are Atom today and are polled every ≥5 min, or pushed through WebSub where offered. Nobody would subscribe to a DATEX II snapshot in a reader. The useful traffic content is human-facing incident text, which authorities publish on web pages and apps, mostly without feeds.

Required behaviour, from most to least important:

1. **Hide expired and Test entries.** Without this, MeteoAlarm is unusable (405 of 406 entries already expired).
2. **Show severity, area and validity in the body** for feeds without a summary (MeteoAlarm, EA, FEMA).
3. **Area filter.** Use the publisher's own URL filters first (NWS `point`, `area`; the `zone` filter returns GeoJSON with FeedFathom's Accept header). An in-app filter only matters for per-country feeds (MeteoAlarm, DWD).
4. **Update and Cancel.** Publishers already emit new entries and drop old ones, but retention does not remove what leaves the feed while any subscriber who could have seen it keeps it, so superseded alerts stay until the user deletes them. Retiring an article in place would need a CAP-identifier ↔ guid mapping. That mapping differs per publisher (NWS guid = URL that contains the identifier; MeteoAlarm guid = per-area index URL), so it is not worth building.

## 4. Recommendation, cheapest first

### (a) Do nothing in code; document the working feed URLs (~1 h). Recommended now.

Add a short user-facing list of the feed URLs that work. The most important item is the NWS `alerts.atom?area=XX&active=1` form, because `/alerts/active?area=` returns GeoJSON with FeedFathom's Accept header. Point to the [Alert Hub sources JSON](https://alert-hub-sources.s3.amazonaws.com/json) as the directory. No files change except the docs.

### (b) Minimal CAP awareness (~6–8 h; add ~6–10 h for dereferencing)

1. **Read `cap:*` from Atom/RSS entries and render it** (~6–8 h). Detect the CAP namespace in the feed text, re-parse with `parseXml` (`src/platform/xml.ts`), and match entries by id. Then:
   - prepend a small definition list to the body: event, severity/urgency/certainty, onset–expires, areaDesc;
   - **skip items whose `expires` has passed or whose `status` is not `Actual`** when mapping;
   - optionally take NAAD's `category term="language=…"` into the guid, so both languages survive.

   Files:
   - new `src/features/feeds/cap-entry.ts`, a pure extractor and renderer with its test in `src/features/feeds/__tests__/cap-entry.test.ts`;
   - `src/features/feeds/feed-parser.ts` (`parseGenericFeed` attaches the extracted fields);
   - `src/features/feeds/feed-mapper.ts` (`mapFeedItemToArticle` renders the fields and filters expired entries; preview uses the same path).

   Ceiling: an article stored before it expired stays until every subscriber who could have seen it deletes it (see §1). Hiding it at read time would need an `expires_at` column (`src/platform/db/schemas/articles.ts` plus a migration plus `article-data-service.ts`), about 4 h more.
2. **Dereference the linked CAP XML** for link-only feeds such as EA and FEMA (+6–10 h). One extra GET per **new, unexpired** guid through `HttpClient`. The per-host rate limiter makes fetching hundreds of entries per poll slow, so only new ones may be fetched, which needs an existing-guid lookup in `article-data-service.ts`. Only worth it if users ask for EA or IPAWS.
3. Cancel/Update retirement: **skip** (reasons in §3).

### (c) Larger work. Not recommended.

- **In-app geofilter** (~25–40 h). Sources are shared between subscribers, so the filter must be per user source at read time. This needs:
  - an area-of-interest column on `user_sources` (`src/platform/db/schemas/user-sources.ts`);
  - stored alert geometry or geocodes per article (new column or table);
  - point-in-polygon and geocode matching in a pure helper;
  - a filter in the reader article queries (`src/features/reader/`, `article-data-service.ts`);
  - SPA settings UI.

  Publisher URL filters cover NWS for free. Only per-country feeds (MeteoAlarm, DWD) would benefit.
- **DATEX II adapter** (~40–80 h, open-ended). It would need gzip snapshot ingestion of 4–8 MB XML, mapping per national profile from situation records to articles, location decoding (ALERT-C/GML) and diffing of the snapshot state. Registration would have to be handled per country. The result would still be coded, text-poor items. Point users at human-facing traffic sites instead.
