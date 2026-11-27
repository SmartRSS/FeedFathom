import {
  type CapAlert,
  buildCapAlert,
  isCapNamespace,
} from "#features/feeds/cap-entry.ts";
import { parseFeedDate } from "#features/feeds/feed-date.ts";
import type {
  FeedItemMedia,
  FeedMapperInput,
  FeedMapperItem,
} from "#features/feeds/feed-mapper.ts";
import {
  asHtmlText,
  decodeHtmlReferences,
  hasHtmlTag,
  stripHtmlTags,
} from "#features/feeds/plain-text.ts";

type XmlAttributes = Record<string, string>;

type XmlElementNode = {
  attributes?: XmlAttributes;
  children?: readonly XmlChildNode[];
  name: string;
};

type XmlChildNode =
  | string
  | XmlElementNode
  | { comment: string }
  | { data?: string; target: string };

type ParsedAuthor = {
  email: string | null;
  name: string | null;
  url: string | null;
};

type ParsedMediaItem = FeedItemMedia & {
  length: number | null;
};

type ParsedFeedItem = Omit<FeedMapperItem, "authors" | "media"> & {
  authors: ParsedAuthor[];
  media: ParsedMediaItem[];
};

export type ParsedXmlFeed = Omit<FeedMapperInput, "items"> & {
  authors: ParsedAuthor[];
  items: ParsedFeedItem[];
};

type XmlContext = {
  baseUrl: string | null;
  hasMrss: boolean;
  inCapScope: boolean;
  namespaces: ReadonlyMap<string, string> | null;
};

type SplitName = {
  local: string;
  prefix: string;
};

const groupClosers: Readonly<Record<string, string>> = {
  "(": ")",
  "<": ">",
  "[": "]",
};
const mailtoPattern = /^mailto:/i;
const mrssHttp = "http://search.yahoo.com/mrss/";
const mrssHttps = "https://search.yahoo.com/mrss/";
const itunesNs = "http://www.itunes.com/dtds/podcast-1.0.dtd";

const isElementNode = (node: unknown): node is XmlElementNode =>
  typeof node === "object" &&
  node !== null &&
  "name" in node &&
  typeof node.name === "string";

const splitName = (rawName: string): SplitName => {
  const lower = rawName.toLowerCase();
  const colon = lower.indexOf(":");
  if (colon === -1) return { local: lower, prefix: "" };
  return { local: lower.slice(colon + 1), prefix: lower.slice(0, colon) };
};

const getAttr = (
  attrs: XmlAttributes | undefined,
  lowerName: string,
): string | null => {
  if (!attrs) return null;
  if (Object.hasOwn(attrs, lowerName)) {
    const direct = attrs[lowerName];
    return direct !== undefined && direct.length > 0 ? direct : null;
  }
  let matched: string | null = null;
  for (const key in attrs) {
    if (Object.hasOwn(attrs, key) && key.toLowerCase() === lowerName) {
      const value = attrs[key];
      matched = value !== undefined && value.length > 0 ? value : null;
    }
  }
  return matched;
};

const resolveUrl = (url: string, baseUrl: string | null): string => {
  if (baseUrl) {
    try {
      return new URL(url, baseUrl).href;
    } catch {}
  }
  return url;
};

const getAttrAsUrl = (
  attrs: XmlAttributes | undefined,
  lowerName: string,
  baseUrl: string | null,
): string | null => {
  const value = getAttr(attrs, lowerName);
  return value ? resolveUrl(value.trim(), baseUrl) : null;
};

const getAttrAsNumber = (
  attrs: XmlAttributes | undefined,
  lowerName: string,
): number | null => {
  const value = getAttr(attrs, lowerName);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const childContext = (
  attrs: XmlAttributes | undefined,
  parent: XmlContext,
): XmlContext => {
  if (!attrs) return parent;
  let hasXmlBase = false;
  let hasXmlns = false;
  for (const key in attrs) {
    if (!Object.hasOwn(attrs, key)) continue;
    const first = key.charCodeAt(0);
    if (first !== 120 && first !== 88) continue;
    const lower = key.toLowerCase();
    if (lower === "xml:base") hasXmlBase = true;
    else if (lower === "xmlns" || lower.startsWith("xmlns:")) hasXmlns = true;
  }
  if (!hasXmlBase && !hasXmlns) return parent;

  let baseUrl = parent.baseUrl;
  if (hasXmlBase) {
    const xmlBase = getAttr(attrs, "xml:base");
    if (xmlBase) {
      if (parent.baseUrl) {
        try {
          baseUrl = new URL(xmlBase, parent.baseUrl).href;
        } catch {
          baseUrl = xmlBase;
        }
      } else {
        baseUrl = xmlBase;
      }
    }
  }

  let namespaces = parent.namespaces;
  let inCapScope = parent.inCapScope;
  let hasMrss = parent.hasMrss;
  if (hasXmlns) {
    const next = new Map(parent.namespaces ?? undefined);
    for (const key in attrs) {
      if (!Object.hasOwn(attrs, key)) continue;
      const lower = key.toLowerCase();
      if (lower === "xmlns") {
        const uri = String(attrs[key]).trim();
        next.set("", uri);
        if (isCapNamespace(uri)) inCapScope = true;
        if (isMediaRssUri(uri)) hasMrss = true;
      } else if (lower.startsWith("xmlns:")) {
        const uri = String(attrs[key]).trim();
        next.set(lower.slice(6), uri);
        if (isCapNamespace(uri)) inCapScope = true;
        if (isMediaRssUri(uri)) hasMrss = true;
      }
    }
    namespaces = next;
  }

  return { baseUrl, hasMrss, inCapScope, namespaces };
};

const isMediaRssUri = (uri: string | undefined): boolean =>
  uri === mrssHttp || uri === mrssHttps;

const isMediaRssNode = (
  node: XmlElementNode,
  prefix: string,
  parentCtx: XmlContext,
): boolean => {
  if (!parentCtx.hasMrss && !node.attributes) return false;
  const ctx = childContext(node.attributes, parentCtx);
  if (!ctx.hasMrss) return false;
  return isMediaRssUri(ctx.namespaces?.get(prefix));
};

const textContent = (node: XmlElementNode): string => {
  const children = node.children;
  if (!children || children.length === 0) return "";
  if (children.length === 1) {
    const only = children[0];
    if (typeof only === "string") return only;
    return isElementNode(only) ? textContent(only) : "";
  }
  let out = "";
  for (const child of children) {
    if (typeof child === "string") out += child;
    else if (isElementNode(child)) out += textContent(child);
  }
  return out;
};

const textContentNormalized = (node: XmlElementNode): string => {
  const trimmed = textContent(node).trim();
  return trimmed.includes("&") ? decodeHtmlReferences(trimmed) : trimmed;
};

const hasOnlyTextChildren = (node: XmlElementNode): boolean => {
  const children = node.children;
  if (!children) return true;
  for (const child of children) {
    if (isElementNode(child)) return false;
  }
  return true;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const serializeChildren = (
  children: readonly XmlChildNode[] | undefined,
): string => {
  if (!children || children.length === 0) return "";
  let xml = "";
  for (const child of children) {
    if (typeof child === "string") {
      xml += escapeXml(child);
      continue;
    }
    if (!isElementNode(child)) continue;
    let attributes = "";
    if (child.attributes) {
      for (const key in child.attributes) {
        if (!Object.hasOwn(child.attributes, key)) continue;
        attributes += ` ${key}="${escapeXml(String(child.attributes[key]))}"`;
      }
    }
    xml += `<${child.name}${attributes}>${serializeChildren(child.children)}</${child.name}>`;
  }
  return xml;
};

const innerHtml = (node: XmlElementNode): string => {
  const serialized = serializeChildren(node.children).trim();
  return serialized.includes("&")
    ? decodeHtmlReferences(serialized)
    : serialized;
};

const unwrapGrouped = (text: string): string => {
  const first = text[0];
  if (first === undefined) return text;
  const closer = groupClosers[first];
  if (closer !== undefined && text.at(-1) === closer) {
    return text.slice(1, -1);
  }
  return text;
};

const parseContactString = (authorString: string): ParsedAuthor | null => {
  if (!authorString.trim()) return null;
  const words = authorString.split(" ").map((originalText) => {
    let text = unwrapGrouped(originalText);
    const lower = text.toLowerCase();
    const isUrl = lower.startsWith("http://") || lower.startsWith("https://");
    const isEmail = !isUrl && text.includes("@");
    if (isEmail) text = text.replace(mailtoPattern, "");
    return { isEmail, isUrl, text };
  });

  const email = words.find(({ isEmail }) => isEmail)?.text ?? null;
  const url = words.find(({ isUrl }) => isUrl)?.text ?? null;
  let name: string | null = authorString;
  if (email || url) {
    name =
      words
        .filter(({ isEmail, isUrl }) => !isEmail && !isUrl)
        .map(({ text }) => text)
        .join(" ")
        .trim() || null;
  }
  if (name) name = unwrapGrouped(name);
  return { email, name, url };
};

const findFirstChild = (
  node: XmlElementNode,
  targetLocal: string,
): { node: XmlElementNode; prefix: string } | null => {
  const children = node.children;
  if (!children) return null;
  for (const child of children) {
    if (!isElementNode(child)) continue;
    const { local, prefix } = splitName(child.name);
    if (local === targetLocal) return { node: child, prefix };
  }
  return null;
};

const extractAuthorsWithoutMarkup = (
  managingEditors: readonly XmlElementNode[],
  authors: readonly XmlElementNode[],
  creators: readonly XmlElementNode[],
): ParsedAuthor[] | undefined => {
  const raw: string[] = [];
  let foundMarkup = false;
  for (const list of [managingEditors, authors, creators]) {
    for (const element of list) {
      if (!hasOnlyTextChildren(element)) continue;
      const text = textContentNormalized(element);
      if (hasHtmlTag(text)) foundMarkup = true;
      raw.push(text);
    }
  }
  if (!foundMarkup) return undefined;
  const parsed: ParsedAuthor[] = [];
  for (const text of raw) {
    const contact = parseContactString(stripHtmlTags(text));
    if (contact !== null) parsed.push(contact);
  }
  return parsed;
};

const parseAtomAuthor = (
  author: XmlElementNode,
  parentCtx: XmlContext,
): ParsedAuthor | null => {
  const authorCtx = childContext(author.attributes, parentCtx);
  let name: string | null = null;
  let uri: string | null = null;
  let url: string | null = null;
  let email: string | null = null;
  if (author.children) {
    for (const child of author.children) {
      if (!isElementNode(child)) continue;
      const { local } = splitName(child.name);
      if (local === "name" && name === null) {
        name = textContentNormalized(child) || null;
      } else if (local === "uri" && uri === null) {
        const ctx = childContext(child.attributes, authorCtx);
        uri = resolveUrl(textContent(child).trim(), ctx.baseUrl) || null;
      } else if (local === "url" && url === null) {
        const ctx = childContext(child.attributes, authorCtx);
        url = resolveUrl(textContent(child).trim(), ctx.baseUrl) || null;
      } else if (local === "email" && email === null) {
        email = textContentNormalized(child) || null;
      }
    }
  }
  const resolvedUrl = uri ?? url;
  if (name || resolvedUrl || email) {
    return { email, name, url: resolvedUrl };
  }
  return parseContactString(textContentNormalized(author));
};

const parseMrssItem = (
  mediaItem: XmlElementNode,
  parentNode: XmlElementNode,
  parentCtx: XmlContext,
): ParsedMediaItem | null => {
  const mediaCtx = childContext(mediaItem.attributes, parentCtx);
  const url = getAttrAsUrl(mediaItem.attributes, "url", mediaCtx.baseUrl);
  if (!url) return null;

  const length =
    getAttrAsNumber(mediaItem.attributes, "length") ??
    getAttrAsNumber(mediaItem.attributes, "filesize");
  const mimeType = getAttr(mediaItem.attributes, "type")?.toLowerCase() ?? null;
  const medium = getAttr(mediaItem.attributes, "medium")?.toLowerCase() ?? null;
  const type =
    medium ?? (mimeType !== null ? (mimeType.split("/")[0] ?? null) : null);

  let thumbnail: string | null = null;
  for (const [host, hostCtx] of [
    [mediaItem, mediaCtx],
    [parentNode, parentCtx],
  ] as const) {
    const thumb = findFirstChild(host, "thumbnail");
    if (!thumb || !isMediaRssNode(thumb.node, thumb.prefix, hostCtx)) continue;
    const thumbCtx = childContext(thumb.node.attributes, hostCtx);
    const thumbUrl = getAttrAsUrl(
      thumb.node.attributes,
      "url",
      thumbCtx.baseUrl,
    );
    if (thumbUrl) {
      thumbnail = thumbUrl;
      break;
    }
  }
  thumbnail ??= type === "image" ? url : null;

  let title: string | null = null;
  for (const [host, hostCtx, tag] of [
    [mediaItem, mediaCtx, "title"],
    [parentNode, parentCtx, "title"],
    [mediaItem, mediaCtx, "description"],
    [parentNode, parentCtx, "description"],
  ] as const) {
    const candidate = findFirstChild(host, tag);
    if (
      !candidate ||
      !isMediaRssNode(candidate.node, candidate.prefix, hostCtx)
    )
      continue;
    const text = textContentNormalized(candidate.node);
    if (text) {
      title = text;
      break;
    }
  }

  return { image: thumbnail, length, mimeType, title, type, url };
};

const collectMrssMedia = (
  itemNode: XmlElementNode,
  itemCtx: XmlContext,
  mrssContents: readonly XmlElementNode[],
  mrssGroups: readonly { ctx: XmlContext; node: XmlElementNode }[],
  out: ParsedMediaItem[],
): void => {
  for (const content of mrssContents) {
    const media = parseMrssItem(content, itemNode, itemCtx);
    if (media) out.push(media);
  }
  for (const { ctx: groupCtx, node: group } of mrssGroups) {
    if (!group.children) continue;
    for (const child of group.children) {
      if (!isElementNode(child)) continue;
      const { local, prefix } = splitName(child.name);
      if (local === "content" && isMediaRssNode(child, prefix, groupCtx)) {
        const media = parseMrssItem(child, group, groupCtx);
        if (media) out.push(media);
      }
    }
  }
};

const dedupeMedia = (items: ParsedMediaItem[]): ParsedMediaItem[] => {
  if (items.length <= 1) return items;
  const seen = new Set<string>();
  const deduped: ParsedMediaItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    deduped.push(item);
  }
  return deduped;
};

const findMediaDescription = (
  itemDescriptions: readonly XmlElementNode[],
  mrssGroups: readonly { ctx: XmlContext; node: XmlElementNode }[],
): string | undefined => {
  for (const desc of itemDescriptions) {
    const text = textContent(desc);
    if (text.trim()) return text;
  }
  for (const { ctx: groupCtx, node: group } of mrssGroups) {
    if (!group.children) continue;
    for (const child of group.children) {
      if (!isElementNode(child)) continue;
      const { local, prefix } = splitName(child.name);
      if (local !== "description" || !isMediaRssNode(child, prefix, groupCtx))
        continue;
      const text = textContent(child);
      if (text.trim()) return text;
    }
  }
  return undefined;
};

const readCapFields = (
  entry: XmlElementNode,
  entryCtx: XmlContext,
): CapAlert | undefined => {
  if (!entry.children) return undefined;
  const fields = new Map<string, string>();
  for (const child of entry.children) {
    if (!isElementNode(child)) continue;
    const { local, prefix } = splitName(child.name);
    const ctx = childContext(child.attributes, entryCtx);
    if (!isCapNamespace(ctx.namespaces?.get(prefix))) continue;
    if (!fields.has(local)) fields.set(local, textContent(child).trim());
  }
  return buildCapAlert(fields);
};

const extractAtomLanguageCategory = (node: XmlElementNode): string | null => {
  if (!node.children) return null;
  let subjectMatch: string | null = null;
  for (const child of node.children) {
    if (!isElementNode(child)) continue;
    const { local } = splitName(child.name);
    if (local === "category") {
      const term = getAttr(child.attributes, "term");
      if (term?.startsWith("language=")) return term.slice("language=".length);
    } else if (local === "subject" && subjectMatch === null) {
      const term = textContentNormalized(child);
      if (term.startsWith("language="))
        subjectMatch = term.slice("language=".length);
    }
  }
  return subjectMatch;
};

const hasAnyAtomCategory = (node: XmlElementNode): boolean => {
  if (!node.children) return false;
  for (const child of node.children) {
    if (!isElementNode(child)) continue;
    const { local } = splitName(child.name);
    if (local === "category" && getAttr(child.attributes, "term")) return true;
    if (local === "subject" && textContentNormalized(child)) return true;
  }
  return false;
};

const isItunesElement = (
  node: XmlElementNode,
  prefix: string,
  parentCtx: XmlContext,
): boolean => {
  if (prefix === "itunes") return true;
  const ctx = childContext(node.attributes, parentCtx);
  return ctx.namespaces?.get(prefix) === itunesNs;
};

const collectItunesSubcategories = (
  child: XmlElementNode,
  level1: string,
  level1Ctx: XmlContext,
  out: string[],
): boolean => {
  if (!child.children) return false;
  let addedChild = false;
  for (const sub of child.children) {
    if (!isElementNode(sub)) continue;
    const subName = splitName(sub.name);
    if (
      subName.local !== "category" ||
      !isItunesElement(sub, subName.prefix, level1Ctx)
    ) {
      continue;
    }
    const level2 = getAttr(sub.attributes, "text");
    if (level2) {
      out.push(`${level1}/${level2}`);
      addedChild = true;
    }
  }
  return addedChild;
};

const collectRssCategoryTerms = (
  node: XmlElementNode,
  nodeCtx: XmlContext,
): string[] => {
  if (!node.children) return [];
  const plain: string[] = [];
  const itunes: string[] = [];
  const subjects: string[] = [];
  for (const child of node.children) {
    if (!isElementNode(child)) continue;
    const { local, prefix } = splitName(child.name);
    if (local === "category") {
      if (isItunesElement(child, prefix, nodeCtx)) {
        const level1 = getAttr(child.attributes, "text");
        if (!level1) continue;
        const level1Ctx = childContext(child.attributes, nodeCtx);
        if (!collectItunesSubcategories(child, level1, level1Ctx, itunes)) {
          itunes.push(level1);
        }
      } else {
        const term = textContentNormalized(child);
        if (term) plain.push(term);
      }
    } else if (local === "subject") {
      const term = textContentNormalized(child);
      if (term) subjects.push(term);
    }
  }
  return [...plain, ...itunes, ...subjects];
};

const extractCapLanguage = (
  item: XmlElementNode,
  itemCtx: XmlContext,
  isAtom: boolean,
  feedLanguageFallback: () => string | null,
): string => {
  const xmlLang = getAttr(item.attributes, "xml:lang");
  if (xmlLang !== null) return xmlLang;
  if (isAtom) {
    const own = extractAtomLanguageCategory(item);
    if (own !== null) return own;
    if (hasAnyAtomCategory(item)) return "";
    return feedLanguageFallback() ?? "";
  }
  const terms = collectRssCategoryTerms(item, itemCtx);
  if (terms.length > 0) {
    const found = terms.find((term) => term.startsWith("language="));
    return found ? found.slice("language=".length) : "";
  }
  return feedLanguageFallback() ?? "";
};

const resolveAgainstFeedUrl = (
  url: string | null,
  feedUrl: string | null,
): string | null => {
  if (!url) return null;
  try {
    return new URL(url, feedUrl ?? undefined).href;
  } catch {
    return url;
  }
};

const parseRssItem = (
  itemNode: XmlElementNode,
  parentCtx: XmlContext,
  feedUrl: string | null,
  feedAuthors: ParsedAuthor[],
  feedLanguageFallback: () => string | null,
): ParsedFeedItem => {
  const itemCtx = childContext(itemNode.attributes, parentCtx);
  let guidNode: XmlElementNode | null = null;
  let titleNode: XmlElementNode | null = null;
  let descNode: XmlElementNode | null = null;
  let encodedNode: { node: XmlElementNode; prefix: string } | null = null;
  let pubDateNode: XmlElementNode | null = null;
  let dateNode: XmlElementNode | null = null;
  let firstLinkUrl: string | null = null;
  let managingEditors: XmlElementNode[] | null = null;
  let authorNodes: XmlElementNode[] | null = null;
  let creatorNodes: XmlElementNode[] | null = null;
  let enclosures: XmlElementNode[] | null = null;
  let mrssContents: XmlElementNode[] | null = null;
  let mrssGroups: { ctx: XmlContext; node: XmlElementNode }[] | null = null;
  let mrssDescriptions: XmlElementNode[] | null = null;

  if (itemNode.children) {
    for (const child of itemNode.children) {
      if (!isElementNode(child)) continue;
      const { local, prefix } = splitName(child.name);
      switch (local) {
        case "guid": {
          guidNode ??= child;
          break;
        }
        case "title": {
          titleNode ??= child;
          break;
        }
        case "description": {
          descNode ??= child;
          if (isMediaRssNode(child, prefix, itemCtx)) {
            mrssDescriptions ??= [];
            mrssDescriptions.push(child);
          }
          break;
        }
        case "encoded": {
          encodedNode ??= { node: child, prefix };
          break;
        }
        case "link": {
          if (firstLinkUrl === null && textContentNormalized(child)) {
            const linkCtx = childContext(child.attributes, itemCtx);
            firstLinkUrl =
              resolveUrl(textContent(child).trim(), linkCtx.baseUrl) || null;
          }
          break;
        }
        case "pubdate": {
          pubDateNode ??= child;
          break;
        }
        case "date": {
          dateNode ??= child;
          break;
        }
        case "managingeditor": {
          managingEditors ??= [];
          managingEditors.push(child);
          break;
        }
        case "author": {
          authorNodes ??= [];
          authorNodes.push(child);
          break;
        }
        case "creator": {
          creatorNodes ??= [];
          creatorNodes.push(child);
          break;
        }
        case "enclosure": {
          enclosures ??= [];
          enclosures.push(child);
          break;
        }
        case "content": {
          if (isMediaRssNode(child, prefix, itemCtx)) {
            mrssContents ??= [];
            mrssContents.push(child);
          }
          break;
        }
        case "group": {
          if (isMediaRssNode(child, prefix, itemCtx)) {
            mrssGroups ??= [];
            mrssGroups.push({
              ctx: childContext(child.attributes, itemCtx),
              node: child,
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const content =
    encodedNode?.prefix === "content"
      ? textContentNormalized(encodedNode.node) || null
      : null;
  let description = descNode ? textContentNormalized(descNode) || null : null;
  if (
    content === null &&
    description === null &&
    (mrssDescriptions !== null || mrssGroups !== null)
  ) {
    const mediaDesc = asHtmlText(
      findMediaDescription(mrssDescriptions ?? [], mrssGroups ?? []),
    );
    if (mediaDesc) description = mediaDesc;
  }

  const parsedDate = dateNode ? parseFeedDate(textContent(dateNode)) : null;
  const published =
    (pubDateNode ? parseFeedDate(textContent(pubDateNode)) : null) ??
    parsedDate;
  const updated = parsedDate ?? published;

  let authors: ParsedAuthor[];
  const stripped =
    managingEditors || authorNodes || creatorNodes
      ? extractAuthorsWithoutMarkup(
          managingEditors ?? [],
          authorNodes ?? [],
          creatorNodes ?? [],
        )
      : undefined;
  if (stripped !== undefined) {
    authors = stripped;
  } else if (authorNodes || creatorNodes) {
    const itemAuthors: ParsedAuthor[] = [];
    for (const list of [authorNodes, creatorNodes]) {
      if (!list) continue;
      for (const el of list) {
        const contact = parseContactString(textContentNormalized(el));
        if (contact !== null) itemAuthors.push(contact);
      }
    }
    authors = itemAuthors.length > 0 ? itemAuthors : feedAuthors;
  } else {
    authors = feedAuthors;
  }

  let media: ParsedMediaItem[] = [];
  if (enclosures || mrssContents || mrssGroups) {
    const list: ParsedMediaItem[] = [];
    if (enclosures) {
      for (const enclosure of enclosures) {
        const encCtx = childContext(enclosure.attributes, itemCtx);
        const encUrl = getAttrAsUrl(
          enclosure.attributes,
          "url",
          encCtx.baseUrl,
        );
        if (!encUrl) continue;
        const length = getAttrAsNumber(enclosure.attributes, "length");
        const mimeType =
          getAttr(enclosure.attributes, "type")?.toLowerCase() ?? null;
        const type =
          mimeType !== null ? (mimeType.split("/")[0] ?? null) : null;
        list.push({
          image: type === "image" ? encUrl : null,
          length,
          mimeType,
          title: null,
          type,
          url: encUrl,
        });
      }
    }
    if (mrssContents || mrssGroups) {
      collectMrssMedia(
        itemNode,
        itemCtx,
        mrssContents ?? [],
        mrssGroups ?? [],
        list,
      );
    }
    media = dedupeMedia(list);
  }

  const item: ParsedFeedItem = {
    authors,
    content,
    description,
    id: guidNode ? textContentNormalized(guidNode) || null : null,
    media,
    published,
    title: titleNode ? textContentNormalized(titleNode) || null : null,
    updated,
    url: resolveAgainstFeedUrl(firstLinkUrl, feedUrl),
  };

  if (itemCtx.inCapScope) {
    const language = extractCapLanguage(
      itemNode,
      itemCtx,
      false,
      feedLanguageFallback,
    );
    const cap = readCapFields(itemNode, itemCtx);
    item.language = language;
    if (cap !== undefined) item.cap = cap;
  }

  return item;
};

const parseAtomItem = (
  entryNode: XmlElementNode,
  parentCtx: XmlContext,
  feedUrl: string | null,
  feedAuthors: ParsedAuthor[],
  feedLanguageFallback: () => string | null,
): ParsedFeedItem => {
  const entryCtx = childContext(entryNode.attributes, parentCtx);
  let idNode: XmlElementNode | null = null;
  let titleNode: XmlElementNode | null = null;
  let summaryNode: XmlElementNode | null = null;
  let contentNode: XmlElementNode | null = null;
  let publishedNode: XmlElementNode | null = null;
  let issuedNode: XmlElementNode | null = null;
  let modifiedNode: XmlElementNode | null = null;
  let updatedNode: XmlElementNode | null = null;
  let firstAltLink: XmlElementNode | null = null;
  let firstNoRelLink: XmlElementNode | null = null;
  let enclosureLinks: XmlElementNode[] | null = null;
  let managingEditors: XmlElementNode[] | null = null;
  let authorNodes: XmlElementNode[] | null = null;
  let creatorNodes: XmlElementNode[] | null = null;
  let mrssContents: XmlElementNode[] | null = null;
  let mrssGroups: { ctx: XmlContext; node: XmlElementNode }[] | null = null;
  let mrssDescriptions: XmlElementNode[] | null = null;

  if (entryNode.children) {
    for (const child of entryNode.children) {
      if (!isElementNode(child)) continue;
      const { local, prefix } = splitName(child.name);
      switch (local) {
        case "id": {
          idNode ??= child;
          break;
        }
        case "title": {
          titleNode ??= child;
          break;
        }
        case "summary": {
          summaryNode ??= child;
          break;
        }
        case "content": {
          contentNode ??= child;
          if (isMediaRssNode(child, prefix, entryCtx)) {
            mrssContents ??= [];
            mrssContents.push(child);
          }
          break;
        }
        case "published": {
          publishedNode ??= child;
          break;
        }
        case "issued": {
          issuedNode ??= child;
          break;
        }
        case "modified": {
          modifiedNode ??= child;
          break;
        }
        case "updated": {
          updatedNode ??= child;
          break;
        }
        case "link": {
          const rel = getAttr(child.attributes, "rel");
          if (rel === "alternate" && firstAltLink === null) {
            firstAltLink = child;
          } else if (rel === null && firstNoRelLink === null) {
            firstNoRelLink = child;
          } else if (rel === "enclosure") {
            enclosureLinks ??= [];
            enclosureLinks.push(child);
          }
          break;
        }
        case "managingeditor": {
          managingEditors ??= [];
          managingEditors.push(child);
          break;
        }
        case "author": {
          authorNodes ??= [];
          authorNodes.push(child);
          break;
        }
        case "creator": {
          creatorNodes ??= [];
          creatorNodes.push(child);
          break;
        }
        case "group": {
          if (isMediaRssNode(child, prefix, entryCtx)) {
            mrssGroups ??= [];
            mrssGroups.push({
              ctx: childContext(child.attributes, entryCtx),
              node: child,
            });
          }
          break;
        }
        case "description": {
          if (isMediaRssNode(child, prefix, entryCtx)) {
            mrssDescriptions ??= [];
            mrssDescriptions.push(child);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  let content: string | null = null;
  if (contentNode) {
    const innerDiv =
      getAttr(contentNode.attributes, "type") === "xhtml"
        ? findFirstChild(contentNode, "div")
        : null;
    content = innerDiv
      ? innerHtml(innerDiv.node)
      : textContentNormalized(contentNode) || null;
  }

  let description = summaryNode
    ? textContentNormalized(summaryNode) || null
    : null;
  if (
    content === null &&
    description === null &&
    (mrssDescriptions !== null || mrssGroups !== null)
  ) {
    const mediaDesc = asHtmlText(
      findMediaDescription(mrssDescriptions ?? [], mrssGroups ?? []),
    );
    if (mediaDesc) description = mediaDesc;
  }

  let rawUrl: string | null = null;
  if (firstAltLink) {
    const linkCtx = childContext(firstAltLink.attributes, entryCtx);
    rawUrl = getAttrAsUrl(firstAltLink.attributes, "href", linkCtx.baseUrl);
  }
  if (!rawUrl && firstNoRelLink) {
    const linkCtx = childContext(firstNoRelLink.attributes, entryCtx);
    rawUrl = getAttrAsUrl(firstNoRelLink.attributes, "href", linkCtx.baseUrl);
  }

  const published =
    (publishedNode ? parseFeedDate(textContent(publishedNode)) : null) ??
    (issuedNode ? parseFeedDate(textContent(issuedNode)) : null);
  const updated =
    (modifiedNode ? parseFeedDate(textContent(modifiedNode)) : null) ??
    (updatedNode ? parseFeedDate(textContent(updatedNode)) : null) ??
    published;

  let authors: ParsedAuthor[];
  const stripped =
    managingEditors || authorNodes || creatorNodes
      ? extractAuthorsWithoutMarkup(
          managingEditors ?? [],
          authorNodes ?? [],
          creatorNodes ?? [],
        )
      : undefined;
  if (stripped !== undefined) {
    authors = stripped;
  } else if (authorNodes) {
    const itemAuthors: ParsedAuthor[] = [];
    for (const el of authorNodes) {
      const parsed = parseAtomAuthor(el, entryCtx);
      if (parsed !== null) itemAuthors.push(parsed);
    }
    authors = itemAuthors.length > 0 ? itemAuthors : feedAuthors;
  } else {
    authors = feedAuthors;
  }

  let media: ParsedMediaItem[] = [];
  if (enclosureLinks || mrssContents || mrssGroups) {
    const list: ParsedMediaItem[] = [];
    if (enclosureLinks) {
      for (const link of enclosureLinks) {
        const linkCtx = childContext(link.attributes, entryCtx);
        const encUrl = getAttrAsUrl(link.attributes, "href", linkCtx.baseUrl);
        if (!encUrl) continue;
        const length = getAttrAsNumber(link.attributes, "length");
        const mimeType =
          getAttr(link.attributes, "type")?.toLowerCase() ?? null;
        const type =
          mimeType !== null ? (mimeType.split("/")[0] ?? null) : null;
        list.push({
          image: type === "image" ? encUrl : null,
          length,
          mimeType,
          title: getAttr(link.attributes, "title"),
          type,
          url: encUrl,
        });
      }
    }
    if (mrssContents || mrssGroups) {
      collectMrssMedia(
        entryNode,
        entryCtx,
        mrssContents ?? [],
        mrssGroups ?? [],
        list,
      );
    }
    media = dedupeMedia(list);
  }

  const item: ParsedFeedItem = {
    authors,
    content,
    description,
    id: idNode ? textContentNormalized(idNode) || null : null,
    media,
    published,
    title: titleNode ? textContentNormalized(titleNode) || null : null,
    updated,
    url: resolveAgainstFeedUrl(rawUrl, feedUrl),
  };

  if (entryCtx.inCapScope) {
    const language = extractCapLanguage(
      entryNode,
      entryCtx,
      true,
      feedLanguageFallback,
    );
    const cap = readCapFields(entryNode, entryCtx);
    item.language = language;
    if (cap !== undefined) item.cap = cap;
  }

  return item;
};

const parseRssFeed = (
  root: XmlElementNode,
  rootCtx: XmlContext,
): ParsedXmlFeed => {
  let channel: XmlElementNode | null = null;
  let rootItems: XmlElementNode[] | null = null;
  if (root.children) {
    for (const child of root.children) {
      if (!isElementNode(child)) continue;
      const { local } = splitName(child.name);
      if (local === "channel" && channel === null) {
        channel = child;
      } else if (local === "item") {
        rootItems ??= [];
        rootItems.push(child);
      }
    }
  }
  if (!channel) {
    throw new Error("The RSS feed does not have a channel element");
  }

  const channelCtx = childContext(channel.attributes, rootCtx);
  let titleNode: XmlElementNode | null = null;
  let descNode: XmlElementNode | null = null;
  let subtitleNode: XmlElementNode | null = null;
  let feedUrl: string | null = null;
  const managingEditors: XmlElementNode[] = [];
  const authorNodes: XmlElementNode[] = [];
  const creatorNodes: XmlElementNode[] = [];
  const channelItems: XmlElementNode[] = [];

  if (channel.children) {
    for (const child of channel.children) {
      if (!isElementNode(child)) continue;
      const { local } = splitName(child.name);
      switch (local) {
        case "item": {
          channelItems.push(child);
          break;
        }
        case "title": {
          titleNode ??= child;
          break;
        }
        case "description": {
          descNode ??= child;
          break;
        }
        case "subtitle": {
          subtitleNode ??= child;
          break;
        }
        case "link": {
          if (feedUrl === null && textContentNormalized(child)) {
            const linkCtx = childContext(child.attributes, channelCtx);
            feedUrl =
              resolveUrl(textContent(child).trim(), linkCtx.baseUrl) || null;
          }
          break;
        }
        case "managingeditor": {
          managingEditors.push(child);
          break;
        }
        case "author": {
          authorNodes.push(child);
          break;
        }
        case "creator": {
          creatorNodes.push(child);
          break;
        }
        default:
          break;
      }
    }
  }

  let feedAuthors = extractAuthorsWithoutMarkup(
    managingEditors,
    authorNodes,
    creatorNodes,
  );
  if (feedAuthors === undefined) {
    feedAuthors = [];
    for (const list of [managingEditors, authorNodes, creatorNodes]) {
      for (const el of list) {
        const contact = parseContactString(textContentNormalized(el));
        if (contact !== null) feedAuthors.push(contact);
      }
    }
  }

  let cachedFeedLang: string | null | undefined;
  const feedLanguageFallback = (): string | null => {
    if (cachedFeedLang === undefined) {
      const terms = collectRssCategoryTerms(channel, channelCtx);
      const found = terms.find((term) => term.startsWith("language="));
      cachedFeedLang = found ? found.slice("language=".length) : null;
    }
    return cachedFeedLang;
  };

  const items: ParsedFeedItem[] = [];
  for (const itemNode of channelItems) {
    items.push(
      parseRssItem(
        itemNode,
        channelCtx,
        feedUrl,
        feedAuthors,
        feedLanguageFallback,
      ),
    );
  }
  if (rootItems) {
    for (const itemNode of rootItems) {
      items.push(
        parseRssItem(
          itemNode,
          rootCtx,
          feedUrl,
          feedAuthors,
          feedLanguageFallback,
        ),
      );
    }
  }

  return {
    authors: feedAuthors,
    description:
      (descNode ? textContentNormalized(descNode) : "") ||
      (subtitleNode ? textContentNormalized(subtitleNode) : "") ||
      null,
    items,
    title: titleNode ? textContentNormalized(titleNode) || null : null,
    url: feedUrl,
  };
};

const parseAtomFeed = (
  root: XmlElementNode,
  rootCtx: XmlContext,
): ParsedXmlFeed => {
  let titleNode: XmlElementNode | null = null;
  let subtitleNode: XmlElementNode | null = null;
  let taglineNode: XmlElementNode | null = null;
  let firstAltLink: XmlElementNode | null = null;
  let firstNoRelLink: XmlElementNode | null = null;
  const managingEditors: XmlElementNode[] = [];
  const authorNodes: XmlElementNode[] = [];
  const creatorNodes: XmlElementNode[] = [];
  const entries: XmlElementNode[] = [];

  if (root.children) {
    for (const child of root.children) {
      if (!isElementNode(child)) continue;
      const { local } = splitName(child.name);
      switch (local) {
        case "entry": {
          entries.push(child);
          break;
        }
        case "title": {
          titleNode ??= child;
          break;
        }
        case "subtitle": {
          subtitleNode ??= child;
          break;
        }
        case "tagline": {
          taglineNode ??= child;
          break;
        }
        case "link": {
          const rel = getAttr(child.attributes, "rel");
          if (rel === "alternate" && firstAltLink === null) {
            firstAltLink = child;
          } else if (rel === null && firstNoRelLink === null) {
            firstNoRelLink = child;
          }
          break;
        }
        case "managingeditor": {
          managingEditors.push(child);
          break;
        }
        case "author": {
          authorNodes.push(child);
          break;
        }
        case "creator": {
          creatorNodes.push(child);
          break;
        }
        default:
          break;
      }
    }
  }

  let feedUrl: string | null = null;
  if (firstAltLink) {
    const linkCtx = childContext(firstAltLink.attributes, rootCtx);
    feedUrl = getAttrAsUrl(firstAltLink.attributes, "href", linkCtx.baseUrl);
  }
  if (!feedUrl && firstNoRelLink) {
    const linkCtx = childContext(firstNoRelLink.attributes, rootCtx);
    feedUrl = getAttrAsUrl(firstNoRelLink.attributes, "href", linkCtx.baseUrl);
  }

  let feedAuthors = extractAuthorsWithoutMarkup(
    managingEditors,
    authorNodes,
    creatorNodes,
  );
  if (feedAuthors === undefined) {
    feedAuthors = [];
    for (const el of authorNodes) {
      const parsed = parseAtomAuthor(el, rootCtx);
      if (parsed !== null) feedAuthors.push(parsed);
    }
  }

  let cachedFeedLang: string | null | undefined;
  const feedLanguageFallback = (): string | null => {
    if (cachedFeedLang === undefined) {
      cachedFeedLang = extractAtomLanguageCategory(root);
    }
    return cachedFeedLang;
  };

  const items: ParsedFeedItem[] = [];
  for (const entry of entries) {
    items.push(
      parseAtomItem(entry, rootCtx, feedUrl, feedAuthors, feedLanguageFallback),
    );
  }

  return {
    authors: feedAuthors,
    description:
      (subtitleNode ? textContentNormalized(subtitleNode) : "") ||
      (taglineNode ? textContentNormalized(taglineNode) : "") ||
      null,
    items,
    title: titleNode ? textContentNormalized(titleNode) || null : null,
    url: feedUrl,
  };
};

const rootContext: XmlContext = {
  baseUrl: null,
  hasMrss: false,
  inCapScope: false,
  namespaces: null,
};

const parseRoot = (xml: string): XmlElementNode => {
  const root: unknown = Bun.XML.parse(xml, { compact: false });
  if (!isElementNode(root)) {
    throw new Error("The XML document could not be parsed as a feed");
  }
  return root;
};

const collectLinkRels = (
  node: XmlElementNode,
  rels: Map<string, string>,
): void => {
  if (rels.size === 2) return;
  const rawName = node.name;
  if (rawName.length === 4 || rawName.length === 9) {
    const name = rawName.toLowerCase();
    if (name === "link" || name === "atom:link") {
      const rel = getAttr(node.attributes, "rel")?.toLowerCase();
      if ((rel === "hub" || rel === "self") && !rels.has(rel)) {
        const href = getAttr(node.attributes, "href");
        if (href) rels.set(rel, href);
        if (rels.size === 2) return;
      }
    }
  }
  const children = node.children;
  if (!children) return;
  for (const child of children) {
    if (isElementNode(child)) {
      collectLinkRels(child, rels);
      if (rels.size === 2) return;
    }
  }
};

export const parseXmlFeedTree = (xml: string): ParsedXmlFeed =>
  feedFromRoot(parseRoot(xml));

export const parseXmlFeedTreeWithLinks = (
  xml: string,
): { feed: ParsedXmlFeed; linkRels: Map<string, string> } => {
  const root = parseRoot(xml);
  const linkRels = new Map<string, string>();
  collectLinkRels(root, linkRels);
  return { feed: feedFromRoot(root), linkRels };
};

const feedFromRoot = (root: XmlElementNode): ParsedXmlFeed => {
  const { local } = splitName(root.name);
  const ctx = childContext(root.attributes, rootContext);
  if (local === "feed") return parseAtomFeed(root, ctx);
  if (local === "rss" || local === "rdf") return parseRssFeed(root, ctx);
  throw new Error("The XML document could not be parsed as a feed");
};
