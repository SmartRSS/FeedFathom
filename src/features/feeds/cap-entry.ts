/**
 * The `cap:*` fields CAP alert feeds (NWS, MeteoAlarm, AirNow) embed in each
 * Atom entry or RSS item. @rowanmanning/feed-parser keeps its XML element
 * private, so a feed that declares the CAP namespace is parsed a second time
 * here and matched back to the parser's items by position: entries are found
 * the way the parser finds them, which keeps every one in document order.
 */
import { type Static, Type } from "typebox";
import { isXmlElement, parseXml, type XmlElement } from "#platform/xml.ts";

export const capAlertSchema = Type.Object(
  {
    areaDesc: Type.String(),
    certainty: Type.String(),
    event: Type.String(),
    expires: Type.String(),
    msgType: Type.String(),
    onset: Type.String(),
    severity: Type.String(),
    status: Type.String(),
    urgency: Type.String(),
  },
  { additionalProperties: false },
);
export type CapAlert = Static<typeof capAlertSchema>;

const capNamespace = /urn:oasis:names:tc:emergency:cap:1\.[12]/u;
/** True for a feed that declares the CAP namespace. */
export const isCapFeed = (text: string): boolean => capNamespace.test(text);
const capNamespaces = new Set([
  "urn:oasis:names:tc:emergency:cap:1.1",
  "urn:oasis:names:tc:emergency:cap:1.2",
]);

/** Namespace URI per prefix in scope; "" is the default namespace. */
type Scope = Readonly<Record<string, string>>;
/** Bun.XML collapses an element without attributes or children to a string. */
type Node = { name: string; node: string | XmlElement; scope: Scope };

const withDeclarations = (element: XmlElement, scope: Scope): Scope => {
  const declared = Object.entries(element).flatMap(([key, value]) =>
    typeof value === "string" && (key === "@xmlns" || key.startsWith("@xmlns:"))
      ? [[key.slice("@xmlns:".length), value.trim()]]
      : [],
  );
  return declared.length === 0
    ? scope
    : { ...scope, ...Object.fromEntries(declared) };
};

const childrenOf = ({ node, scope }: Node): Node[] =>
  typeof node === "string"
    ? []
    : Object.entries(node)
        .filter(([name]) => !name.startsWith("@") && !name.startsWith("#"))
        .flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).flatMap((child): Node[] => {
            if (typeof child === "string")
              return [{ name, node: child, scope }];
            return isXmlElement(child)
              ? [{ name, node: child, scope: withDeclarations(child, scope) }]
              : [];
          }),
        );

// How @rowanmanning/feed-parser names an element: lowercased, prefix dropped.
const localName = (name: string) => name.toLowerCase().replace(/^[^:]*:/u, "");
const childrenNamed = (parent: Node, name: string) =>
  childrenOf(parent).filter((child) => localName(child.name) === name);

const isCapField = ({ name, scope }: Node) => {
  const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : "";
  return capNamespaces.has(scope[prefix] ?? "");
};

const textOf = ({ node }: Node): string => {
  const text = typeof node === "string" ? node : node["#text"];
  return typeof text === "string" ? text.trim() : "";
};

const readAlert = (entry: Node): CapAlert | undefined => {
  const fields = new Map<string, string>();
  for (const child of childrenOf(entry).filter(isCapField)) {
    const name = child.name.slice(child.name.indexOf(":") + 1);
    if (!fields.has(name)) fields.set(name, textOf(child));
  }
  if (fields.size === 0) return undefined;
  const cap = (name: string) => fields.get(name) ?? "";
  return {
    areaDesc: cap("areaDesc"),
    certainty: cap("certainty"),
    event: cap("event"),
    expires: cap("expires"),
    // MeteoAlarm spells CAP's msgType as message_type.
    msgType: cap("msgType") || cap("message_type"),
    onset: cap("onset") || cap("effective"),
    severity: cap("severity"),
    status: cap("status"),
    urgency: cap("urgency"),
  };
};

/**
 * Each entry's CAP fields, in the parser's item order; empty, without
 * parsing, for a non-CAP feed.
 */
export const capAlerts = (text: string): (CapAlert | undefined)[] => {
  if (!isCapFeed(text)) return [];
  let document: Node;
  try {
    document = { name: "", node: parseXml(text), scope: {} };
  } catch {
    // The feed parser tolerates markup Bun.XML rejects; such a feed keeps
    // its articles, just without alert details.
    return [];
  }
  const root = [
    ...childrenNamed(document, "feed"),
    ...childrenNamed(document, "rss"),
    ...childrenNamed(document, "rdf"),
  ][0];
  if (!root) return [];
  const entries =
    localName(root.name) === "feed"
      ? childrenNamed(root, "entry")
      : [...childrenNamed(root, "channel").slice(0, 1), root].flatMap(
          (parent) => childrenNamed(parent, "item"),
        );
  // Bun.XML groups siblings by tag, so entries spelled two ways (item and
  // rss:item) lose their relative order.
  if (new Set(entries.map((entry) => entry.name)).size > 1) return [];
  return entries.map(readAlert);
};

/** Gives each parsed item whose entry carries CAP fields a `cap` property. */
export const attachCapAlerts = (
  text: string,
  items: readonly object[],
): void => {
  const alerts = capAlerts(text);
  if (alerts.length !== items.length) return;
  for (const [index, item] of items.entries()) {
    const alert = alerts[index];
    if (alert) Object.assign(item, { cap: alert });
  }
};

/**
 * False once the alert has expired or when it is not a real alert (Test,
 * Exercise, System, Draft). A missing status or expiry hides nothing.
 */
export const isCapAlertCurrent = (alert: CapAlert, now: number): boolean => {
  const expiresAt = Date.parse(alert.expires);
  return (
    (alert.status === "" || alert.status === "Actual") &&
    (Number.isNaN(expiresAt) || expiresAt > now)
  );
};

const renderedFields = [
  ["Event", "event"],
  ["Severity", "severity"],
  ["Urgency", "urgency"],
  ["Certainty", "certainty"],
  ["Area", "areaDesc"],
  ["Onset", "onset"],
  ["Expires", "expires"],
  ["Message type", "msgType"],
] as const;

/** The alert as a definition list, its publisher-supplied text escaped. */
export const renderCapAlert = (alert: CapAlert): string => {
  const rows = renderedFields
    .filter(([, key]) => alert[key])
    .map(
      ([label, key]) =>
        `<dt>${label}</dt><dd>${Bun.escapeHTML(alert[key])}</dd>`,
    )
    .join("");
  return rows ? `<dl>${rows}</dl>` : "";
};
