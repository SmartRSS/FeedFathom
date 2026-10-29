/**
 * The `cap:*` fields CAP alert feeds (NWS, MeteoAlarm, AirNow) embed in each
 * Atom entry or RSS item, read from the parser's own element for the entry.
 */
import type { Element } from "@rowanmanning/feed-parser/lib/xml/element.js";
import { type Static, Type } from "typebox";

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
/**
 * A cheap pre-filter: false means the feed cannot be a CAP feed. True only
 * means the URI appears somewhere, which article content can also do.
 */
export const mentionsCapNamespace = (text: string): boolean =>
  capNamespace.test(text);
const capNamespaces = new Set([
  "urn:oasis:names:tc:emergency:cap:1.1",
  "urn:oasis:names:tc:emergency:cap:1.2",
]);
const isCapNamespace = (uri: null | string | undefined) =>
  capNamespaces.has(uri ?? "");

/**
 * True when the entry or an ancestor declares the CAP namespace, even if a
 * nearer declaration rebinds that prefix: entry guids depend on this.
 */
export const inCapScope = (entry: Element | null): boolean =>
  entry !== null &&
  (Object.entries(entry.attributes).some(
    ([name, value]) =>
      (name === "xmlns" || name.startsWith("xmlns:")) &&
      isCapNamespace(value.trim()),
  ) ||
    inCapScope(entry.parent));

/**
 * The entry's CAP fields, or undefined when it has none. The parser hands
 * back element names lowercased, prefix dropped.
 */
export const readCapAlert = (entry: Element): CapAlert | undefined => {
  const fields = new Map<string, string>();
  for (const child of entry.children) {
    if (typeof child === "string" || !isCapNamespace(child.namespaceUri))
      continue;
    if (!fields.has(child.name))
      fields.set(child.name, child.textContent.trim());
  }
  if (fields.size === 0) return undefined;
  const cap = (name: string) => fields.get(name) ?? "";
  return {
    areaDesc: cap("areadesc"),
    certainty: cap("certainty"),
    event: cap("event"),
    expires: cap("expires"),
    // MeteoAlarm spells CAP's msgType as message_type.
    msgType: cap("msgtype") || cap("message_type"),
    onset: cap("onset") || cap("effective"),
    severity: cap("severity"),
    status: cap("status"),
    urgency: cap("urgency"),
  };
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
