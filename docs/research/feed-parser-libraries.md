# Feed parser libraries for Node

Research note, 2026-11-15. All feeds were fetched on that date. Every
library received the same decoded text for each feed, so the results compare
parsers only, not fetching or charset detection.

## TL;DR

1. Keep `@rowanmanning/feed-parser`. On 961 real XML feeds it parsed all 961.
   No candidate parsed more.
2. Do not switch to `@extractus/feed-extractor`. It rejects a whole feed on any
   well-formedness error (8 of 961 feeds failed), rejects an Atom feed with no
   entries, and by default returns a 250-character plain-text teaser instead of
   the article body.
3. `rss-parser` (rbren) is the most downloaded, but its last npm release was
   in April 2023. It failed 2 of 961 feeds, on a bare `&`, and does not read
   `<atom:feed>`.
4. The real reliability gap is ours. The `Bun.XML` shim behind feed-parser is a
   strict XML processor. In production, FeedFathom fails **7 of 675 (1.0%)**
   public feeds that the stock library parses. The production-only check in
   [upcoming-upgrades.md](../upcoming-upgrades.md#what-it-was-measured-against)
   could not show this: production holds only feeds that already worked.
   These rejections are not Bun bugs. Each one is required by XML 1.0, and
   canary behaves the same.

## Candidates

| Library | npm downloads/week | Latest npm release | GitHub stars | Open issues | XML layer |
|---|---:|---|---:|---:|---|
| `@rowanmanning/feed-parser` (ours) | 28,599 | 2.1.5, 2026-09-09 | 51 | 16 | fast-xml-parser (ours: `Bun.XML` shim) |
| `@extractus/feed-extractor` | 21,292 | 8.0.4, 2026-11-15 | 192 | 0 | fast-xml-parser + `XMLValidator` gate |
| `rss-parser` (rbren) | 1,207,262 | 3.13.0, 2023-04-11 | 1,530 | 84 | xml2js (sax) |
| `feedparser` (danmactough) | 27,222 | 2.6.1, 2026-11-02 | 1,971 | 1 | sax, non-strict, streaming |
| `feedsmith` | 188,488 | 3.0.1, 2026-09-25 | 637 | 51 | fast-xml-parser |

`feedparser` and `feedsmith` were not in the original question. They are
included because they are the other two widely used parsers, and each had
the best result on at least one test.

Which library FeedFathom used before `@rowanmanning/feed-parser` is not in
the repository. The first public commit (2025-01-02) already depends on
feed-parser 1.1.0, and no earlier code exists on GitHub. The `@types/xml2js`
in that commit came from the `opml` package. The owner recalls `rss-parser`.

## Method

Three corpora:

- **Owner's subscriptions**: 219 OPML entries plus 79 hand-picked public
  feeds (podcasts, YouTube, Reddit, GitHub, Mastodon, Bluesky, Blogger,
  Medium, RDF, Japanese, Polish and German news). 286 XML feeds and 2 JSON
  Feeds returned a feed body.
- **Public, uncurated**: every feed in the
  [plenaryapp/awesome-rss-feeds](https://github.com/plenaryapp/awesome-rss-feeds)
  OPMLs that was not already in the first set. Of 818 URLs, 675 returned an
  XML feed. These are not filtered by "works in FeedFathom", so they show the
  failure rate a new user would see.
- **Edge cases**: 35 small documents, each one a defect seen in real feeds,
  plus the 5 fixtures in `src/features/feeds/__tests__/feed-parser-cases/`.

For each feed and library the harness recorded: whether it threw, the item
count against a regex count of `<item>`/`<entry>` elements, and for each item
whether it had a title, an absolute link, a parseable date, an id and a body.
"FeedFathom (prod)" is our real `parseFeedDocument` under Bun 1.4.4, with the
`Bun.XML` shim and our overrides. The libraries ran stock under Node 22.

## Results on real feeds

Feeds that threw, or returned the wrong item count:

| | Owner's (286) | Public (675) | Total (961) |
|---|---:|---:|---:|
| `@rowanmanning/feed-parser` | 0 | 0 | **0** |
| `@extractus/feed-extractor` | 1 | 7 | 8 (0.8%) |
| `rss-parser` | 0 | 2 | 2 (0.2%) |
| `feedparser` | 0 | 0 | 0 |
| `feedsmith` | 0 | 0 | 0 |
| FeedFathom (prod) | 0 | 7 | 7 (0.7%) |

Every library that parsed a feed returned the reference item count. None of
them dropped items without throwing.

What broke, in the public corpus:

| Defect in the feed | Feeds | Fails in |
|---|---:|---|
| `<script>` after `</rss>` (a WordPress cache plugin) | 2 | extractus, prod |
| Whitespace before `<?xml` | 2 | extractus, prod |
| Bare `&` in a title (`bots, & misinformation`) | 2 | extractus, rss-parser, prod |
| Control character `0x0C` in text | 1 | prod |
| Atom feed with zero entries (Vox) | 1 | extractus |

Field coverage, on the 667 public feeds (67,940 items) that every library
parsed:

| | title | link | date | id | body |
|---|---:|---:|---:|---:|---:|
| `@rowanmanning/feed-parser` | 99.8% | 85.7% | 98.3% | 98.3% | 96.8% |
| `@extractus/feed-extractor` | 99.8% | 85.7% | 98.3% | 100%¹ | 96.7%² |
| `rss-parser` | 99.8% | 85.7% | 99.4% | 98.3% | 96.6% |
| `feedparser` | 99.8% | 86.4%³ | 99.4% | 100%¹ | 96.8% |
| `feedsmith` | 99.8% | 85.7% | 99.4% | 98.6% | 96.8% |
| FeedFathom (prod) | 99.8% | 85.7% | 99.4% | 98.3% | 97.7%⁴ |

1. Synthesised from the link when the feed has no guid.
2. A body, but only a 250-character plain-text teaser by default.
3. Uses a permalink `<guid>` as the link when `<link>` is missing.
4. Includes our Media RSS description fallback (YouTube).

Stock feed-parser loses 1.1 points on dates because fast-xml-parser leaves
numeric character references undecoded: two feeds write the offset as
`&#43;0000` and lose every date. Under `Bun.XML` that is fixed.

Speed, total parse time over the 675 public feeds: feedsmith 3.7 s,
FeedFathom (prod, Bun) 8.2 s, feed-parser 9.4 s, feed-extractor 10.5 s,
rss-parser 13.7 s, feedparser 23.3 s. On one 5,000-item feed, stock
feed-parser took 1,624 ms; the others took 56–144 ms. Our pinning of
`url`/`authors`/`categories` (#1031) brings prod down to 166 ms.

## Results on edge cases

"ok" means every item came through with the expected fields.

| Case | feed-parser | feed-extractor | rss-parser | feedparser | feedsmith | prod |
|---|---|---|---|---|---|---|
| Bare `&` in text and URL | ok | **throws** | ok | ok | ok | **throws** |
| `&eacute;` `&nbsp;` (HTML entities) | ok | left encoded | ok | ok | ok | **throws** |
| Whitespace before `<?xml` | ok | **throws** | ok | ok | ok | **throws** |
| Control characters in text | ok | ok | ok | ok | ok | **throws** |
| Unescaped HTML in `<description>` | **loses next item** | throws | throws | ok, body empty | ok | throws |
| `<Title>…</title>` | ok | throws | throws | ok | throws | throws |
| Truncated document | throws | throws | throws | recovers 2 of 3 | throws | throws |
| `<atom:feed>` prefixed root | ok | throws | throws | ok | ok | ok |
| Atom with no entries | ok | **throws** | ok | ok | ok | ok |
| Atom `type="xhtml"` | ok | title, body empty | title is an object | ok | ok | ok |
| Relative links, `xml:base` | resolved | **dropped** | raw | resolved | raw | resolved |
| `content:encoded` + `description` | full body | teaser | full body | full body | full body | full body |
| `dc:date` only | ok | **no date** | ok | ok | ok | ok |
| `CEST`, `IST` zone names | no date | no date | no date | no date | raw string | ok |
| `pon, 01 wrz 2026` (Polish) | no date | no date | no date | no date | raw string | no date |
| Entity-expansion DTD | not expanded | not expanded | throws | not expanded | not expanded | rejected |
| External entity (XXE) | rejected | rejected | throws | ignored | rejected | rejected |
| HTML page, not a feed | rejected | rejected | rejected | rejected | rejected | rejected |

No library read .NET's `<a10:link>` / `<a10:updated>` in RSS. Of the 134
non-feed bodies in the public corpus, feed-extractor accepted 3 as empty
feeds: JSON error responses (`{"code":"wp_die",…}`, a Cloudflare 522) that it
took for JSON Feeds. Every other library rejected all 134.

## Per library

**`@rowanmanning/feed-parser`.** The most forgiving of the fast-xml-parser
family, and the only one besides feedparser that read mismatched tag case. It
resolves relative links against the channel link and `xml:base`, and exposes
the raw element tree, which our CAP, Media RSS and author code depends on.
Weak points: one maintainer and 16 open issues; untyped (we check the shape
with `parsedFeedSchema`); the quadratic fallback getters we already pin; and
unescaped HTML in a description silently swallows the items after it.

**`@extractus/feed-extractor`.** Built for previews, not for a reader. Every
document goes through `XMLValidator` first, so one bare `&` loses the whole
feed. Its defaults return a stripped, 250-character `description`, preferring
it over `content:encoded`, and drop links it cannot make absolute.
`descriptionMaxLen: 0`, `baseUrl` and `getExtraEntryFields` work around the
field problems, but no option removes the validation gate. It has JSON Feed
support.

**`rss-parser`.** Lenient through xml2js, but the package is unmaintained:
no release since 3.13.0 in April 2023 and 84 open issues. It returns parsed
xhtml titles as objects and does not handle a prefixed Atom root or JSON
Feed.

**`feedparser`.** The most tolerant: it recovered part of a truncated
document and every malformed case except an unescaped-HTML body. It is also
the slowest (2.5× feed-parser), uses a stream API, and has old dependencies
(`readable-stream` 2, a pinned `sax` range). It does not handle JSON Feed.

**`feedsmith`.** The fastest by 2.5×, typed, with JSON Feed and many
namespaces built in. It was the only parser that kept the unescaped-HTML body
intact. Dates come back as raw strings for the caller to parse. It depends on
fast-xml-parser, so in FeedFathom it would run through our `Bun.XML` shim and
inherit the same strictness. The shim implements only the `preserveOrder` mode
feed-parser uses, so it would also need extending.

## Is the `Bun.XML` strictness a Bun bug?

No. Every rejection above breaks an XML 1.0 well-formedness rule:

| Error | XML 1.0 rule |
|---|---|
| `Only one root element is allowed` (script after `</rss>`) | `document ::= prolog element Misc*` |
| `'<?xml' is reserved …` (whitespace before it) | The XML declaration must be first; `xml` is a reserved PI target |
| `Expected an entity name after '&'` | `&` must start a reference |
| `Entity 'eacute' is not declared` | WFC: Entity Declared |
| `control character 0x0C` | `Char` excludes C0 controls other than tab, LF, CR |
| Mismatched or missing end tags | WFC: Element Type Match |

The [`Bun.XML` docs](https://github.com/oven-sh/bun/blob/main/docs/runtime/xml.mdx)
state the contract: "throws a `SyntaxError` when the document is not
well-formed (there is no lenient mode)". The parser passes all 1,679
applicable cases of the W3C XML Conformance Test Suite. The design PR,
[oven-sh/bun#38724](https://github.com/oven-sh/bun/pull/38724), fixed the
API shape before 1.4 shipped and does not discuss a lenient mode. No issue
asks for one.

`1.4.5-canary.1+9098897a1` (2026-11-15) behaves exactly like 1.4.4: the same 7
public feeds fail with the same messages. Across all three corpora,
production output does not differ by a single field.

Asking Bun for a recovery mode would be a feature request against a stated
contract, not a bug report. The repair belongs on our side. The `SyntaxError`
carries `line` and `column`, so a repair pass can fix the reported position
instead of rewriting the whole document.

## Recommendation

1. Keep `@rowanmanning/feed-parser`. No candidate is more reliable on real
   feeds, and switching would mean rewriting the element-level code built on
   it.
2. Close the `Bun.XML` gap. All 7 public feeds that fail in prod fail on
   defects a lenient parser accepts. On a `SyntaxError`, retry once after a
   repair pass: trim before `<?xml`, cut after the root's closing tag, escape
   a `&` that does not start an entity, map HTML named entities to
   characters, and drop C0 control characters. That covers every observed
   failure without bringing back fast-xml-parser. Done: `repairXml` and
   `parseRepairingXml` in `src/features/feeds/xml.ts`, on both the feed and
   OPML paths. On the 961-feed corpus it recovers all 7 failures, and the
   other 954 feeds parse to identical values.
3. Revisit `feedsmith` only if feed-parser stops being maintained. It is the
   strongest alternative, but the shim would need the same repair pass.

## Not covered

- Charset detection. Each library received text that was already decoded; we
  do this in `decodeXml` before parsing.
- Enclosures, Media RSS, podcast namespaces and categories.
- Memory use, and the libraries' own fetch helpers.
