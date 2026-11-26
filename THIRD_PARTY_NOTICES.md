# Third-Party Notices

The MIT License in [LICENSE](LICENSE) covers FeedFathom's own code. The
third-party files and test fixtures listed below are not relicensed under
FeedFathom's MIT License and retain their own licenses and terms.

## Third-party assets and test fixtures

| Path | Description | Source | License |
| --- | --- | --- | --- |
| `src/spa/assets/fonts/selawik.woff2`, `src/spa/assets/fonts/selawik-bold.woff2` | Selawik font files (Copyright 2015, Microsoft Corporation; Reserved Font Name "Selawik") | [microsoft/Selawik](https://github.com/microsoft/Selawik) | SIL Open Font License 1.1 (`src/spa/assets/fonts/selawik-LICENSE.txt`) |
| `src/spa/assets/icons/**/*.svg` | 18 unmodified Lucide UI glyphs (7 derived from Feather) | [Lucide](https://lucide.dev) / [Feather](https://feathericons.com) | ISC License (Copyright (c) 2026 Lucide Icons and Contributors); Feather-derived glyphs also under MIT License (Copyright (c) 2013-present Cole Bemis) (`src/spa/assets/icons/LICENSE`) |
| `src/spa/assets/{48,64,96,128}-inverted-round.png`, `src/spa/public/icons/{48,64,96,128}-inverted-round.png` | Application, PWA, and browser extension PNG icons (copied into extension packages by `bin/generate-packages.ts`; PNG metadata lists Adobe ImageReady, no license file in repo) | Unknown (pre-dates shallow history graft; originally in `lib/images/`) | **Unknown** |
| `src/features/feeds/__tests__/feed-parser-golden/` | 49 pseudonymised XML feed fixtures modified by FeedFathom (2026-11-26) from `rowanmanning/sample-feeds`, selected per `@rowanmanning/feed-parser` v2.1.5, plus `<name>.expected.json` snapshots | [rowanmanning/sample-feeds](https://github.com/rowanmanning/sample-feeds) (commit `a2dd1a6d1430294e154c2729f0c0615e431dbbe5`) and [rowanmanning/feed-parser](https://github.com/rowanmanning/feed-parser) v2.1.5 (`d4682589022ce84c1ab0c0471ca9b1959fa74a15`) | GNU General Public License v3.0 (modified fixtures); MIT License (`@rowanmanning/feed-parser` v2.1.5 notice) (`src/features/feeds/__tests__/feed-parser-golden/LICENSE`) |
| `src/features/feeds/__tests__/cap-entry-cases/dwd.xml` | Real-world CAP weather alert feed capture | Deutscher Wetterdienst (`https://www.dwd.de/DWD/warnungen/cap-feed/de/atom.xml`) | Public domain (per `<rights>` / `<dc:rights>` in file) |
| `src/features/feeds/__tests__/cap-entry-cases/meteoalarm-poland.xml` | Real-world CAP weather alert feed capture | MeteoAlarm.Org (`https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-poland`) | Copyright © 2026 MeteoAlarm.Org; terms equivalent to CC BY 4.0 with additional redistribution requirements in MeteoAlarm Terms and Conditions (per `<rights>` in file) |
| `src/features/feeds/__tests__/cap-entry-cases/nws-kansas.xml` | Real-world CAP weather alert feed capture | US National Weather Service / NOAA (`https://api.weather.gov/alerts.atom`) | US federal government work (public domain in the United States under 17 U.S.C. § 105; no license notice in file) |
| `src/features/feeds/__tests__/feed-parser-cases/naad-bilingual.xml` | Real-world bilingual NAADS alert feed capture | Pelmorex / Environment Canada (`http://rss.naad-adna.pelmorex.com/feed.atom`) | **Unknown** (no license notice in file) |

## Audited directories containing FeedFathom's own files

The following directories were audited and contain FeedFathom's own MIT-licensed
code or synthetic fixtures (no third-party source files):

- `vendor/linkedom-shim/` — FeedFathom's own `DOMParser` shim (`index.js`,
  `package.json`) and its unit test (`vendor/__tests__/shim-fidelity.test.ts`).
- `src/extension/` — FeedFathom's own browser extension code, stylesheets, HTML
  pages, and `manifest.json` (extension builds copy the PNG icons from
  `src/spa/assets/` listed above).
- `src/features/feeds/__tests__/feed-parser-cases/` (except `naad-bilingual.xml`)
  — synthetic XML fixtures (`date-zones.xml`, `date-zones-atom.xml`,
  `markup-authors.xml`, `relative-links-after-redirect.xml`).
- `src/features/feeds/__tests__/opml-parser-cases/` — synthetic OPML test
  fixtures (one input references a third-party URL/title string in
  `inputs/parse-opml/html-escaped-titles.ts`).
