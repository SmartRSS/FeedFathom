// What publishers write after an RFC 822 date. RFC 822 names only UT, GMT,
// Z and the four US zones; JavaScriptCore knows those and refuses the rest.
// An ambiguous name takes its usual reading in feeds: IST is India, CST and
// AST are North American.
const zoneOffsets: Record<string, string> = {
  ACDT: "+1030",
  ACST: "+0930",
  ADT: "-0300",
  AEDT: "+1100",
  AEST: "+1000",
  AKDT: "-0800",
  AKST: "-0900",
  AST: "-0400",
  AWST: "+0800",
  BST: "+0100",
  CDT: "-0500",
  CEST: "+0200",
  CET: "+0100",
  CST: "-0600",
  EDT: "-0400",
  EEST: "+0300",
  EET: "+0200",
  EST: "-0500",
  GMT: "+0000",
  HKT: "+0800",
  HST: "-1000",
  IST: "+0530",
  JST: "+0900",
  KST: "+0900",
  MDT: "-0600",
  MEST: "+0200",
  MET: "+0100",
  MSK: "+0300",
  MST: "-0700",
  NDT: "-0230",
  NST: "-0330",
  NZDT: "+1300",
  NZST: "+1200",
  PDT: "-0700",
  PST: "-0800",
  SGT: "+0800",
  UT: "+0000",
  UTC: "+0000",
  WEST: "+0100",
  WET: "+0000",
  Z: "+0000",
};

const isoWithoutZone =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/iu;
// A numeric offset is left off on purpose: the native parser reads it.
const rfc822WithNamedOrNoZone =
  /^((?:[a-z]+,?\s*)?\d{1,2}\s+[a-z]+\s+\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?)(?:\s+([a-z]{1,5}))?$/iu;

// `new Date` reads a date with no zone in the process's local timezone, so
// the same feed would store different instants on differently configured
// hosts. A feed date with no zone is read as UTC, and so is one with a zone
// name outside the table: hours off beats falling back to the ingest time.
const withExplicitZone = (text: string): string => {
  if (isoWithoutZone.test(text)) {
    return `${text.slice(0, 10)}T${text.slice(11)}Z`;
  }
  const [, dateTime, zone] = rfc822WithNamedOrNoZone.exec(text) ?? [];
  if (dateTime === undefined) return text;
  return `${dateTime} ${zoneOffsets[zone?.toUpperCase() ?? ""] ?? "+0000"}`;
};

/** Reads a feed's date text; null when it names no instant at all. */
export const parseFeedDate = (text: string): Date | null => {
  const date = new Date(withExplicitZone(text.trim()));
  return Number.isNaN(date.getTime()) ? null : date;
};
