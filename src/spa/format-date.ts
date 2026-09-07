import { createSignal } from "solid-js";

// How timestamps render across the app. "locale" is the user's own locale
// and timezone via Intl; "iso" is fixed UTC YYYY-MM-DD HH:mm for people who
// want unambiguous machine-style dates. Relative rendering ("2h ago") stays
// a locale-mode concern; ISO deliberately stays absolute.
export type DateFormat = "iso" | "locale";
const DATE_FORMATS: readonly DateFormat[] = ["locale", "iso"];
const DATE_FORMAT_KEY = "dateFormat";

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(value);
}

function readDateFormat(): DateFormat {
  try {
    const stored = localStorage.getItem(DATE_FORMAT_KEY);
    return stored && isDateFormat(stored) ? stored : "locale";
  } catch {
    return "locale";
  }
}

const [dateFormat, setDateFormatSignal] =
  createSignal<DateFormat>(readDateFormat());
export { dateFormat };

export function setDateFormat(value: DateFormat) {
  setDateFormatSignal(value);
  try {
    localStorage.setItem(DATE_FORMAT_KEY, value);
  } catch {}
}

const pad = (value: number) => String(value).padStart(2, "0");

// Fixed UTC rendering: an offset column invites misreading ("is that my
// time or the server's?"), while everything the API carries is already an
// absolute instant, so one well-labelled frame is the unambiguous choice.
const isoDateTime = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

// The single place a timestamp turns into display text, so a format
// decision is made once per mode, not per call site. The DOM keeps the raw
// value in <time datetime>; only this text varies.
export function formatDate(iso: null | string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (dateFormat() === "iso") return isoDateTime(date);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
