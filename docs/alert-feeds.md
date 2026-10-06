---
layout: default
title: Emergency Alert Feeds
nav_order: 4
---

# Emergency Alert Feeds

Many weather and civil-protection agencies publish their alerts (in the CAP
format) as Atom or RSS feeds. FeedFathom reads these feeds like any other feed.
Add one of the URLs below as a new feed.

The URLs below worked on 2026-10-06.

## Feeds that work

| Publisher | Feed URL |
| --- | --- |
| National Weather Service (US) | `https://api.weather.gov/alerts.atom?area=KS&active=1` |
| MeteoAlarm (Europe, one feed per country) | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-<country>`, for example `meteoalarm-legacy-atom-poland` |
| DWD (Germany) | `https://www.dwd.de/DWD/warnungen/cap-feed/de/atom.xml`, or `/en/atom.xml` for English |
| Environment Canada (NAAD) | `https://rss.naad-adna.pelmorex.com/` |
| FEMA IPAWS (US) | `https://apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest/feed` |
| Environment Agency flood alerts (England) | `https://environment.data.gov.uk/cap/flood-alerts.atom` |
| NOAA tsunami (US) | `https://www.tsunami.gov/events/xml/PAAQAtom.xml` |
| AirNow / EPA air quality (US) | `https://feeds.enviroflash.info/cap/aggregate.xml` |

For the National Weather Service, replace `KS` with your state code. For a
single location, use `point=<lat>,<lon>` instead of `area=`, for example
`https://api.weather.gov/alerts.atom?point=39.1,-94.6&active=1`.

For other countries, the
[WMO Alert Hub sources list](https://alert-hub-sources.s3.amazonaws.com/json)
gives the feed URL of about 230 alerting authorities (the `capAlertFeed`
field). Some entries in it are out of date.

## Use the `alerts.atom` URL for the National Weather Service

Do not use `https://api.weather.gov/alerts/active?area=KS`. For FeedFathom,
that URL returns GeoJSON, not a feed, and the feed fails to load. Use
`https://api.weather.gov/alerts.atom?area=KS&active=1` instead.

The `zone=` filter has the same problem, even in the `alerts.atom` form. Use
`area=` or `point=`.

## Limits

- FeedFathom shows the text that the feed itself contains. Some feeds
  (MeteoAlarm, FEMA, Environment Agency) have no summary, so their articles
  show only a title.
- FeedFathom does not hide expired, updated or cancelled alerts. An alert
  stays in your list until you delete it, even after the publisher removes it
  from the feed. MeteoAlarm feeds also keep many expired alerts.
- FeedFathom cannot filter a feed by area. MeteoAlarm and DWD publish one feed
  for the whole country. Use the publisher's own filter where there is one,
  such as `area` or `point` for the National Weather Service.
- Road-traffic data in the DATEX II format is not supported, and is not
  planned. No publisher we checked offers it as a feed.
