/**
 * Bun's native XML parser (Bun 1.4+), wrapped for our own parsing. Feed XML
 * is parsed by @rowanmanning/feed-parser instead, through
 * vendor/fast-xml-parser-shim on top of the same Bun.XML; it shares only
 * parseRepairingXml from here.
 *
 * Bun.XML.parse's default "compact" shape has three quirks worth hiding:
 * attributes live on the element itself under an "@" prefix, a lone child
 * collapses to a single object instead of a one-element array, and an element
 * with no attributes or child elements is a bare string rather than an object.
 */

import { decodeEntity } from "html-entities";

/** A parsed XML element: "@"-prefixed attributes plus nested children. */
export type XmlElement = Record<string, unknown>;

export const isXmlElement = (value: unknown): value is XmlElement =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Bun.XML caps entity expansion at about 100x the input, which a 24 MiB feed
// body still turns into gigabytes. Entities can only be declared in a
// DOCTYPE's internal subset, so refuse that. An external DTD, such as the one
// RSS 0.91 feeds name, is never fetched and stays harmless.
const internalSubset =
  /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*<!DOCTYPE\b[^[>]*\[/i;

export const rejectXmlEntityDeclarations = (xml: string): void => {
  if (internalSubset.test(xml)) {
    throw new Error("XML entity declarations are not allowed");
  }
};

const xmlEntityNames = new Set(["amp", "lt", "gt", "quot", "apos"]);
const rootNamePattern =
  /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\b[^[>]*>)*<([A-Za-z_][\w.:-]*)/;
// A CDATA section or comment matches whole and is kept as is: a bare `&` is
// legal inside both.
const ampersandPattern =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&(?:(#\d+|#x[\da-fA-F]+|[A-Za-z][A-Za-z\d]*);)?/g;

/**
 * `xml` with the defects real feeds and OPML exports ship repaired: anything
 * before the first tag, characters XML cannot hold, anything after the root
 * element's end tag (a WordPress cache plugin appends a `<script>`), a bare
 * `&`, and HTML named entities such as `&eacute;`. None of these edits can
 * change what a well-formed document parses to, so a feed that was fine
 * before is unaffected. Mismatched or missing end tags are not repaired:
 * that would mean guessing at the structure.
 */
export const repairXml = (xml: string): string => {
  let repaired = xmlSafeText(xml.trimStart());
  const root = rootNamePattern.exec(repaired)?.[1];
  const close = root ? repaired.lastIndexOf(`</${root}`) : -1;
  const end = close === -1 ? -1 : repaired.indexOf(">", close);
  if (end !== -1) repaired = repaired.slice(0, end + 1);
  return repaired.replaceAll(
    ampersandPattern,
    (match, reference: string | undefined) => {
      if (!match.startsWith("&")) return match;
      if (reference === undefined) return "&amp;";
      if (reference.startsWith("#") || xmlEntityNames.has(reference))
        return match;
      const decoded = decodeEntity(match, { level: "html5" });
      // An unknown name, or one that decodes to markup (`&LT;`), stays text.
      if (decoded === match || /[&<>]/.test(decoded))
        return `&amp;${reference};`;
      return decoded;
    },
  );
};

/**
 * `parse(xml)`, or, when Bun.XML rejects the document as malformed,
 * `parse(repairXml(xml))`. If the repaired document fails too, the original
 * error is the one thrown, since it describes the document as fetched.
 */
export const parseRepairingXml = <T>(
  xml: string,
  parse: (xml: string) => T,
): T => {
  try {
    return parse(xml);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    try {
      return parse(repairXml(xml));
    } catch {
      throw error;
    }
  }
};

/**
 * Throws on XML that is malformed beyond what repairXml fixes. Bun.XML is a
 * conforming processor, so this also covers what fast-xml-parser needed a
 * separate XMLValidator pass for.
 */
export const parseXml = (xml: string): XmlElement => {
  rejectXmlEntityDeclarations(xml);
  const parsed: unknown = parseRepairingXml(xml, (text) => Bun.XML.parse(text));
  if (!isXmlElement(parsed)) throw new Error("Invalid XML document");
  return parsed;
};

/**
 * `value` with the characters XML cannot represent removed.
 *
 * Bun.XML.stringify escapes everything that needs escaping, but for these it
 * throws instead: U+0000, the other C0 controls except tab, newline and
 * carriage return, the two noncharacters, and lone surrogates. A feed title
 * can carry any of them, and an export that throws is a worse outcome than
 * one missing a character no reader could have displayed.
 *
 * `\p{Surrogate}` under `u` matches only lone surrogates: a well-formed pair
 * is a single astral code point, which is not in the surrogate range.
 */
export const xmlSafeText = (value: string): string =>
  value
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, "")
    .replaceAll(/\p{Surrogate}/gu, "");

/** An element's `name` attribute, or "" when absent or non-textual. */
export const attribute = (element: XmlElement, name: string): string => {
  const value = element[`@${name}`];
  return typeof value === "string" ? value : "";
};

/** An element's child <name> elements, however many the parser collapsed to. */
export const childElements = (
  element: XmlElement,
  name: string,
): XmlElement[] => {
  const children = element[name];
  if (Array.isArray(children)) return children.filter(isXmlElement);
  return isXmlElement(children) ? [children] : [];
};
