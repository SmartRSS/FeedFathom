import { afterEach, expect, spyOn, test } from "bun:test";
import { formatDate, formatDay, formatRowDate } from "../format-date.ts";
import { dateFormat } from "../preferences.ts";

const setDateFormat = dateFormat.set;
afterEach(() => setDateFormat("locale"));

test("locale mode renders an absolute localized string", () => {
  setDateFormat("locale");
  const date = new Date("2026-09-07T12:34:00Z");
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  expect(formatDate(date.toISOString())).toBe(expected);
});

test("locale mode reuses one formatter instead of building one per call", () => {
  setDateFormat("locale");
  const construct = spyOn(Intl, "DateTimeFormat");
  try {
    formatDate("2026-09-07T12:34:00Z");
    formatDate("2026-01-05T03:07:00Z");
    expect(construct).not.toHaveBeenCalled();
  } finally {
    construct.mockRestore();
  }
});

test("iso mode renders fixed UTC YYYY-MM-DD HH:mm", () => {
  setDateFormat("iso");
  expect(formatDate("2026-09-07T12:34:00Z")).toBe("2026-09-07 12:34");
  expect(formatDate("2026-01-05T03:07:00Z")).toBe("2026-01-05 03:07");
});

test("empty and unparseable values render as nothing in either mode", () => {
  for (const mode of ["locale", "iso"] as const) {
    setDateFormat(mode);
    expect(formatDate(undefined)).toBe("");
    expect(formatDate(null)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("not a date")).toBe("");
  }
});

test("formatDay names the day alone, its year only when not this one", () => {
  setDateFormat("locale");
  const past = new Date("2020-09-07T12:34:00Z");
  expect(formatDay(past.toISOString())).toBe(
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(past),
  );
  const now = new Date();
  expect(formatDay(now.toISOString())).toBe(
    new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
    }).format(now),
  );
  setDateFormat("iso");
  expect(formatDay("2026-09-07T23:34:00Z")).toBe("2026-09-07");
  expect(formatDay(null)).toBe("");
});

test("formatRowDate shortens by how recent the date is", () => {
  setDateFormat("locale");
  // Local-time constructors, so the test holds in any time zone.
  const now = new Date(2026, 8, 7, 15, 0);
  const today = new Date(2026, 8, 7, 9, 5);
  expect(formatRowDate(today.toISOString(), now)).toBe(
    new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(today),
  );
  const thisYear = new Date(2026, 3, 7, 9, 5);
  expect(formatRowDate(thisYear.toISOString(), now)).toBe(
    new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
    }).format(thisYear),
  );
  // The same day and month a year earlier is not today.
  const lastYear = new Date(2025, 8, 7, 9, 5);
  expect(formatRowDate(lastYear.toISOString(), now)).toBe(
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      lastYear,
    ),
  );
});

test("formatRowDate in iso mode is the UTC time today, the UTC date otherwise", () => {
  setDateFormat("iso");
  const now = new Date("2026-09-07T15:00:00Z");
  expect(formatRowDate("2026-09-07T03:07:00Z", now)).toBe("03:07");
  expect(formatRowDate("2026-09-06T23:59:00Z", now)).toBe("2026-09-06");
  expect(formatRowDate("2025-09-07T03:07:00Z", now)).toBe("2025-09-07");
});

test("formatRowDate renders nothing for empty and unparseable values", () => {
  for (const mode of ["locale", "iso"] as const) {
    setDateFormat(mode);
    expect(formatRowDate(undefined)).toBe("");
    expect(formatRowDate(null)).toBe("");
    expect(formatRowDate("not a date")).toBe("");
  }
});

test("formatRowDate reuses the module's formatters", () => {
  setDateFormat("locale");
  const construct = spyOn(Intl, "DateTimeFormat");
  try {
    formatRowDate(new Date().toISOString());
    formatRowDate("2020-01-05T03:07:00Z");
    expect(construct).not.toHaveBeenCalled();
  } finally {
    construct.mockRestore();
  }
});
