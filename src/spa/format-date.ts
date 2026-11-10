import { dateFormat } from "./preferences.ts";

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

const localeTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const localeDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const localeDayOfYear = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
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

// The day alone, for "since" wording where the hour would be noise, and
// its year only when that isn't this one. ISO keeps its fixed form.
export function formatDay(iso: null | string | undefined): string {
  const full = formatDate(iso);
  if (!full || dateFormat.get() === "iso") return full.slice(0, 10);
  const date = new Date(iso ?? "");
  return date.getFullYear() === new Date().getFullYear()
    ? localeDayOfYear.format(date)
    : localeDate.format(date);
}

// A list row's date, as short as it can be said: the time for today, the
// day for this year, the full date before that. The date band over the rows
// already names the period, and the row keeps formatDate's full stamp as
// its tooltip. ISO keeps its fixed UTC frame, so "today" is the UTC day.
export function formatRowDate(
  iso: null | string | undefined,
  now = new Date(),
): string {
  const full = formatDate(iso);
  if (!full) return "";
  if (dateFormat.get() === "iso") {
    const today = now.toISOString().slice(0, 10);
    return full.startsWith(today) ? full.slice(11) : full.slice(0, 10);
  }
  const date = new Date(iso ?? "");
  if (date.getFullYear() !== now.getFullYear()) return localeDate.format(date);
  const sameDay =
    date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? localeTime.format(date) : localeDayOfYear.format(date);
}
