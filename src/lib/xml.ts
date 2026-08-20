/**
 * Thin shim over Bun's native XML parser (Bun 1.4+), which replaces
 * fast-xml-parser for our own parsing.
 *
 * Bun.XML.parse has three quirks worth hiding from call sites: attributes
 * live on the element itself under an "@" prefix, a lone child collapses to
 * a single object instead of a one-element array, and an empty element
 * parses to a string rather than an object.
 *
 * Feed XML is not parsed here -- that goes through @rowanmanning/feed-parser,
 * which brings its own fast-xml-parser.
 */

/** A parsed XML element: "@"-prefixed attributes plus nested children. */
export type XmlElement = Record<string, unknown>;

export const isXmlElement = (value: unknown): value is XmlElement =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Throws on malformed XML, so it also covers what fast-xml-parser needed a
 * separate XMLValidator pass for.
 */
export const parseXml = (xml: string): XmlElement => {
  const parsed: unknown = Bun.XML.parse(xml);
  if (!isXmlElement(parsed)) throw new Error("Invalid XML document");
  return parsed;
};

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
