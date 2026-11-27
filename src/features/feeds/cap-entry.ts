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

const capNamespaces = new Set([
  "urn:oasis:names:tc:emergency:cap:1.1",
  "urn:oasis:names:tc:emergency:cap:1.2",
]);
export const isCapNamespace = (uri: null | string | undefined): boolean =>
  capNamespaces.has(uri ?? "");

export const buildCapAlert = (
  fields: ReadonlyMap<string, string>,
): CapAlert | undefined => {
  if (fields.size === 0) return undefined;
  const cap = (name: string) => fields.get(name) ?? "";
  return {
    areaDesc: cap("areadesc"),
    certainty: cap("certainty"),
    event: cap("event"),
    expires: cap("expires"),
    msgType: cap("msgtype") || cap("message_type"),
    onset: cap("onset") || cap("effective"),
    severity: cap("severity"),
    status: cap("status"),
    urgency: cap("urgency"),
  };
};

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
