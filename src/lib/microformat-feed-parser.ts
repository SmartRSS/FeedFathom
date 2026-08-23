// Microformats2 (h-feed/h-entry, https://microformats.org/wiki/h-entry) has
// no separate machine-readable feed file the way RSS/Atom/JSON Feed do --
// the semantic markup lives directly in the page's own HTML, so the page
// URL itself is the feed URL. Many sites mark up entries loosely on the
// page without an explicit h-feed wrapper, so both top-level h-entry items
// and ones nested inside an h-feed count.
import { mf2 } from "microformats-parser";

type MicroformatRoot = ReturnType<typeof mf2>["items"][number];
type MicroformatProperty = NonNullable<
  MicroformatRoot["properties"]
>[string][number];

const htmlDoctypePattern = /^\s*(?:<!doctype html|<html[\s>])/i;

// Origins that serve a perfectly good RSS/Atom document as `text/html` are
// common enough to matter (WordPress behind a proxy that rewrites the header,
// static hosts that guess a type from the extension). Believing the header
// there hands XML to the microformats parser, which finds no h-entry items
// and fails the whole source. The document's own root element is the more
// reliable witness, so it wins. An XML declaration alone would not be: XHTML
// pages carrying microformats open with one too, which is why this looks past
// it for the root element rather than stopping at `<?xml`.
const feedRootPattern = /^\s*(?:<\?xml[^>]*\?>\s*)?<(?:rss|feed|rdf:RDF)[\s>]/i;

export function isMicroformatHtml(
  text: string,
  contentType: string | null,
): boolean {
  if (feedRootPattern.test(text)) return false;
  return (
    (contentType?.toLowerCase().includes("html") ?? false) ||
    htmlDoctypePattern.test(text)
  );
}

const isRoot = (value: MicroformatProperty): value is MicroformatRoot =>
  typeof value === "object" && value !== null && "properties" in value;

const asText = (value: MicroformatProperty | undefined): string | null => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value)
    return typeof value.value === "string" ? value.value : null;
  return null;
};

function entryContent(root: MicroformatRoot): string | null {
  const content = root.properties["content"]?.[0];
  if (!content) return null;
  if (typeof content === "string") return content;
  return "html" in content ? content.html : asText(content);
}

function entryAuthors(root: MicroformatRoot) {
  return (root.properties["author"] ?? []).map((author) => ({
    name: isRoot(author)
      ? asText(author.properties["name"]?.[0])
      : asText(author),
  }));
}

function mapEntry(root: MicroformatRoot) {
  const properties = root.properties;
  const published = asText(properties["published"]?.[0]);
  const updated = asText(properties["updated"]?.[0]);
  return {
    authors: entryAuthors(root),
    content: entryContent(root),
    description: asText(properties["summary"]?.[0]),
    id: null,
    published: published ? new Date(published) : null,
    title: asText(properties["name"]?.[0]),
    updated: updated ? new Date(updated) : null,
    url: asText(properties["url"]?.[0]),
  };
}

const hasType = (root: MicroformatRoot, type: string): boolean =>
  root.type?.includes(type) ?? false;

export function parseMicroformatFeed(html: string, baseUrl: string) {
  const { items } = mf2(html, { baseUrl });
  const feeds = items.filter((item) => hasType(item, "h-feed"));
  const feedEntries = feeds.flatMap((feed) =>
    (feed.children ?? []).filter((child) => hasType(child, "h-entry")),
  );
  const topLevelEntries = items.filter((item) => hasType(item, "h-entry"));
  const entries = [...feedEntries, ...topLevelEntries];
  if (entries.length === 0) {
    throw new Error(
      "The page has no microformats h-entry items to parse as a feed",
    );
  }

  return {
    description: null,
    items: entries.map(mapEntry),
    title: asText(feeds[0]?.properties["name"]?.[0]),
    url: baseUrl,
  };
}
