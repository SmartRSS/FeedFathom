/**
 * The `cap:*` fields CAP alert feeds (NWS, MeteoAlarm, AirNow) embed in each
 * Atom entry or RSS item. @rowanmanning/feed-parser keeps its XML element
 * private, so a feed that declares the CAP namespace is parsed a second time
 * here and matched back to the parser's items by entry id.
 */
import { type Static, Type } from "typebox";
import {
  childElements,
  isXmlElement,
  parseXml,
  type XmlElement,
} from "#platform/xml.ts";

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

const capNamespacePrefix =
  /xmlns:([\w.-]+)\s*=\s*["']urn:oasis:names:tc:emergency:cap:1\.[12]["']/u;

// An element's text, whether Bun.XML left it a bare string or, because the
// element carries attributes, an object holding "#text".
const textOf = (element: XmlElement, name: string): string => {
  const value = element[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") return first.trim();
  const text = isXmlElement(first) ? first["#text"] : undefined;
  return typeof text === "string" ? text.trim() : "";
};

const readAlert = (entry: XmlElement, prefix: string): CapAlert | undefined => {
  const cap = (name: string) => textOf(entry, `${prefix}:${name}`);
  const alert = {
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
  return Object.values(alert).some(Boolean) ? alert : undefined;
};

/** CAP fields per entry id; empty, without parsing, for a non-CAP feed. */
export const capAlertsById = (text: string): Map<string, CapAlert> => {
  const alerts = new Map<string, CapAlert>();
  const prefix = capNamespacePrefix.exec(text)?.[1];
  if (prefix === undefined) return alerts;
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    // The feed parser tolerates markup Bun.XML rejects; such a feed keeps
    // its articles, just without alert details.
    return alerts;
  }
  const entries = [
    ...childElements(root, "feed").flatMap((feed) =>
      childElements(feed, "entry"),
    ),
    ...childElements(root, "rss").flatMap((rss) =>
      childElements(rss, "channel").flatMap((channel) =>
        childElements(channel, "item"),
      ),
    ),
  ];
  for (const entry of entries) {
    const id = textOf(entry, "id") || textOf(entry, "guid");
    const alert = readAlert(entry, prefix);
    if (id && alert) alerts.set(id, alert);
  }
  return alerts;
};

/** Gives each parsed item whose entry carries CAP fields a `cap` property. */
export const attachCapAlerts = (
  text: string,
  items: readonly { id: string | null }[],
): void => {
  const alerts = capAlertsById(text);
  if (alerts.size === 0) return;
  for (const item of items) {
    const alert = alerts.get(item.id?.trim() ?? "");
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
