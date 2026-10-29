import { afterEach, expect, spyOn, test } from "bun:test";
import { dateFormat, formatDate } from "../format-date.ts";

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
