import { decodeHTMLStrict } from "entities";

export type XmlElement = Record<string, unknown>;

export const isXmlElement = (value: unknown): value is XmlElement =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const internalSubset =
  /^(?:\s|<\?(?:[^?]|\?(?!>))*\?>|<!--(?:[^-]|-(?!->))*-->)*<!DOCTYPE\b[^[>]*\[/i;

export const rejectXmlEntityDeclarations = (xml: string): void => {
  if (internalSubset.test(xml)) {
    throw new Error("XML entity declarations are not allowed");
  }
};

const xmlEntityNames = new Set(["amp", "lt", "gt", "quot", "apos"]);
const rootNamePattern =
  /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\b[^[>]*>)*<([A-Za-z_][\w.:-]*)/;
const ampersandPattern =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&(?:(#\d+|#x[\da-fA-F]+|[A-Za-z][A-Za-z\d]*);)?/g;

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
      const decoded = decodeHTMLStrict(match);
      if (decoded === match || /[&<>]/.test(decoded))
        return `&amp;${reference};`;
      return decoded;
    },
  );
};

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

export const parseXml = (xml: string): XmlElement => {
  rejectXmlEntityDeclarations(xml);
  const parsed: unknown = parseRepairingXml(xml, (text) => Bun.XML.parse(text));
  if (!isXmlElement(parsed)) throw new Error("Invalid XML document");
  return parsed;
};

export const xmlSafeText = (value: string): string =>
  value
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, "")
    .replaceAll(/\p{Surrogate}/gu, "");

export const attribute = (element: XmlElement, name: string): string => {
  const value = element[`@${name}`];
  return typeof value === "string" ? value : "";
};

export const childElements = (
  element: XmlElement,
  name: string,
): XmlElement[] => {
  const children = element[name];
  if (Array.isArray(children)) return children.filter(isXmlElement);
  return isXmlElement(children) ? [children] : [];
};
