import { storedPreference } from "./preferences.ts";

// How timestamps render across the app. "locale" is the user's own locale
// and timezone via Intl; "iso" is fixed UTC YYYY-MM-DD HH:mm for people who
// want unambiguous machine-style dates. Relative rendering ("2h ago") stays
// a locale-mode concern; ISO deliberately stays absolute.
export const dateFormat = storedPreference(
  "dateFormat",
  ["locale", "iso"],
  "locale",
);

const pad = (value: number) => String(value).padStart(2, "0");

// Fixed UTC rendering: an offset column invites misreading ("is that my
// time or the server's?"), while everything the API carries is already an
// absolute instant, so one well-labelled frame is the unambiguous choice.
const isoDateTime = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

// Built once: constructing a formatter costs ~30 µs and formatDate runs per
// article row. The locale and timezone resolve at module load, so a change
// to either mid-session shows after the next page load.
const localeDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// The single place a timestamp turns into display text, so a format
// decision is made once per mode, not per call site. The DOM keeps the raw
// value in <time datetime>; only this text varies.
export function formatDate(iso: null | string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (dateFormat.get() === "iso") return isoDateTime(date);
  return localeDateTime.format(date);
}
