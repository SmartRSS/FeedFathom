/**
 * Bun's native XML parser (Bun 1.4+), wrapped for our own parsing. Feed XML
 * does not come through here -- @rowanmanning/feed-parser needs
 * fast-xml-parser's ordered shape, which vendor/fast-xml-parser-shim provides
 * on top of the same Bun.XML.
 *
 * Bun.XML.parse's default "compact" shape has three quirks worth hiding:
 * attributes live on the element itself under an "@" prefix, a lone child
 * collapses to a single object instead of a one-element array, and an element
 * with no attributes or child elements is a bare string rather than an object.
 */

/** A parsed XML element: "@"-prefixed attributes plus nested children. */
export type XmlElement = Record<string, unknown>;

export const isXmlElement = (value: unknown): value is XmlElement =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Throws on malformed XML. Bun.XML is a conforming processor, so this also
 * covers what fast-xml-parser needed a separate XMLValidator pass for -- at
 * the cost of rejecting documents the tolerant parser used to recover from.
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
