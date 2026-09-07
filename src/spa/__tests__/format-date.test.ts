import { afterEach, expect, test } from "bun:test";
import {
  dateFormat,
  formatDate,
  isDateFormat,
  setDateFormat,
} from "../format-date.ts";

afterEach(() => setDateFormat("locale"));

test.each(["locale", "iso"])("parses each accepted format (%s)", (value) => {
  expect(isDateFormat(value)).toBe(true);
});

test.each(["", "ISO", "unix", "system"])(
  "rejects unknown format %s",
  (value) => {
    expect(isDateFormat(value)).toBe(false);
  },
);

test("locale mode renders an absolute localized string", () => {
  setDateFormat("locale");
  const rendered = formatDate("2026-09-07T12:34:00Z");
  expect(rendered).not.toBe("");
  expect(rendered).toMatch(/\d/);
  // Never a machine-style ISO date: that is the other mode's job.
  expect(rendered).not.toMatch(/^2026-09-07/);
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

test("the preference signal reflects the last set value", () => {
  setDateFormat("iso");
  expect(dateFormat()).toBe("iso");
  setDateFormat("locale");
  expect(dateFormat()).toBe("locale");
});
