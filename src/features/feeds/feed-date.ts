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
const rfc822WithNamedOrNoZone =
  /^((?:[a-z]+,?\s*)?\d{1,2}\s+[a-z]+\s+\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)(?:\s+([a-z]{1,5}))?$/iu;

const hasExplicitZone = (text: string): boolean => {
  const len = text.length;
  if (len < 6) return false;
  const last = text.charCodeAt(len - 1);
  if (last === 90 || last === 122) {
    const prev = text.charCodeAt(len - 2);
    return prev >= 48 && prev <= 57;
  }
  if (
    (last === 84 && text.endsWith(" GMT")) ||
    (last === 67 && text.endsWith(" UTC"))
  ) {
    return true;
  }
  if (last < 48 || last > 57) return false;
  const c5 = text.charCodeAt(len - 5);
  if (c5 === 43 || c5 === 45) return true;
  const c6 = text.charCodeAt(len - 6);
  return (c6 === 43 || c6 === 45) && text.charCodeAt(len - 3) === 58;
};

const withExplicitZone = (text: string): string => {
  if (hasExplicitZone(text)) return text;
  if (isoWithoutZone.test(text)) {
    return `${text.slice(0, 10)}T${text.slice(11)}Z`;
  }
  const match = rfc822WithNamedOrNoZone.exec(text);
  if (match === null) return text;
  const dateTime = match[1];
  const zone = match[2];
  return `${dateTime} ${zoneOffsets[zone?.toUpperCase() ?? ""] ?? "+0000"}`;
};

export const parseFeedDate = (text: string): Date | null => {
  const date = new Date(withExplicitZone(text.trim()));
  return Number.isNaN(date.getTime()) ? null : date;
};
