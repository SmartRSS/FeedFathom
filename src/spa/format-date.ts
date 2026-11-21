import { dateFormat } from "./preferences.ts";

const pad = (value: number) => String(value).padStart(2, "0");

const isoDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const isoTime = (date: Date): string =>
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

const isoDateTime = (date: Date): string => `${isoDate(date)} ${isoTime(date)}`;

const parseDate = (iso: null | string | undefined): Date | undefined => {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

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
  const date = parseDate(iso);
  if (!date) return "";
  if (dateFormat.get() === "iso") return isoDateTime(date);
  return localeDateTime.format(date);
}

export function formatDay(iso: null | string | undefined): string {
  const date = parseDate(iso);
  if (!date) return "";
  if (dateFormat.get() === "iso") return isoDate(date);
  return date.getFullYear() === new Date().getFullYear()
    ? localeDayOfYear.format(date)
    : localeDate.format(date);
}

export function formatRowDate(
  iso: null | string | undefined,
  now = new Date(),
): string {
  const date = parseDate(iso);
  if (!date) return "";
  if (dateFormat.get() === "iso") {
    const day = isoDate(date);
    return day === isoDate(now) ? isoTime(date) : day;
  }
  if (date.getFullYear() !== now.getFullYear()) return localeDate.format(date);
  const sameDay =
    date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? localeTime.format(date) : localeDayOfYear.format(date);
}
