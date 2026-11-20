import { dateFormat } from "./preferences.ts";

const pad = (value: number) => String(value).padStart(2, "0");

const isoDateTime = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

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

export function formatDate(iso: null | string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (dateFormat.get() === "iso") return isoDateTime(date);
  return localeDateTime.format(date);
}

export function formatDay(iso: null | string | undefined): string {
  const full = formatDate(iso);
  if (!full || dateFormat.get() === "iso") return full.slice(0, 10);
  const date = new Date(iso ?? "");
  return date.getFullYear() === new Date().getFullYear()
    ? localeDayOfYear.format(date)
    : localeDate.format(date);
}

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
