import {
  generateBoundaryDates,
  getDateGroup,
} from "../src/util/get-date-group";
import { afterAll, describe, expect, test } from "bun:test";

const generateTestBoundaryDates = (
  fixedDate: string,
): {
  earliestLastMonth: string;
  earliestLastWeek: string;
  earliestLastYear: string;
  earliestOlder: string;
  earliestToday: string;
  latestLastMonth: string;
  latestLastWeek: string;
  latestLastYear: string;
} => {
  const baseDate = new Date(fixedDate);

  // Today's boundary
  const earliestToday = new Date(baseDate);
  earliestToday.setHours(0, 0, 0, 0);

  // Last Week's boundaries
  const latestLastWeek = new Date(earliestToday);
  latestLastWeek.setDate(latestLastWeek.getDate() - 1);
  latestLastWeek.setHours(23, 59, 59, 999);

  const earliestLastWeek = new Date(earliestToday);
  earliestLastWeek.setDate(earliestLastWeek.getDate() - 7);
  earliestLastWeek.setHours(0, 0, 0, 0);

  // Last Month's boundaries
  const latestLastMonth = new Date(earliestLastWeek);
  latestLastMonth.setDate(latestLastMonth.getDate() - 1);
  latestLastMonth.setHours(23, 59, 59, 999);

  const earliestLastMonth = new Date(baseDate);
  earliestLastMonth.setMonth(earliestLastMonth.getMonth() - 1);
  earliestLastMonth.setHours(0, 0, 0, 0);

  // Last Year's boundaries
  const latestLastYear = new Date(earliestLastMonth);
  latestLastYear.setDate(latestLastYear.getDate() - 1);
  latestLastYear.setHours(23, 59, 59, 999);

  const earliestLastYear = new Date(baseDate);
  earliestLastYear.setFullYear(earliestLastYear.getFullYear() - 1);
  earliestLastYear.setHours(0, 0, 0, 0);

  // Older boundary
  const earliestOlder = new Date(earliestLastYear);
  earliestOlder.setDate(earliestOlder.getDate() - 1);
  earliestOlder.setHours(23, 59, 59, 999);

  return {
    earliestLastMonth: earliestLastMonth.toISOString(),
    earliestLastWeek: earliestLastWeek.toISOString(),
    earliestLastYear: earliestLastYear.toISOString(),
    earliestOlder: earliestOlder.toISOString(),
    earliestToday: earliestToday.toISOString(),
    latestLastMonth: latestLastMonth.toISOString(),
    latestLastWeek: latestLastWeek.toISOString(),
    latestLastYear: latestLastYear.toISOString(),
  };
};

describe("generateTestBoundaryDates", () => {
  test("should generate correctly ordered boundary dates", () => {
    const boundaries = generateTestBoundaryDates("2023-01-10T00:00:00Z");

    // Convert all dates to timestamps for easy comparison
    const dates = {
      earliestLastMonth: new Date(boundaries.earliestLastMonth).getTime(),
      earliestLastWeek: new Date(boundaries.earliestLastWeek).getTime(),
      earliestLastYear: new Date(boundaries.earliestLastYear).getTime(),
      earliestOlder: new Date(boundaries.earliestOlder).getTime(),
      earliestToday: new Date(boundaries.earliestToday).getTime(),
      latestLastMonth: new Date(boundaries.latestLastMonth).getTime(),
      latestLastWeek: new Date(boundaries.latestLastWeek).getTime(),
      latestLastYear: new Date(boundaries.latestLastYear).getTime(),
    };

    // Verify chronological ordering
    expect(dates.earliestOlder).toBeLessThan(dates.earliestLastYear);
    expect(dates.earliestLastYear).toBeLessThan(dates.latestLastYear);
    expect(dates.latestLastYear).toBeLessThan(dates.earliestLastMonth);
    expect(dates.earliestLastMonth).toBeLessThan(dates.latestLastMonth);
    expect(dates.latestLastMonth).toBeLessThan(dates.earliestLastWeek);
    expect(dates.earliestLastWeek).toBeLessThan(dates.latestLastWeek);
    expect(dates.latestLastWeek).toBeLessThan(dates.earliestToday);

    // Verify time boundaries are set correctly
    expect(new Date(boundaries.earliestToday).getHours()).toBe(0);
    expect(new Date(boundaries.earliestToday).getMinutes()).toBe(0);
    expect(new Date(boundaries.earliestToday).getSeconds()).toBe(0);

    expect(new Date(boundaries.latestLastWeek).getHours()).toBe(23);
    expect(new Date(boundaries.latestLastWeek).getMinutes()).toBe(59);
    expect(new Date(boundaries.latestLastWeek).getSeconds()).toBe(59);
  });
});

describe("getDateGroup", () => {
  // Define test dates covering various edge cases
  const testDates = [
    // Regular date in middle of month
    "2023-01-10T00:00:00Z",
    // Leap year date
    "2000-02-29T11:00:00Z",
    // Month with 31 days transitioning to month with 30 days
    "2023-08-01T15:30:00Z",
    // End of year transition
    "2024-01-01T00:00:00Z",
    // February in non-leap year
    "2023-02-28T23:59:59Z",
    // Date near DST transition
    "2023-03-12T02:30:00Z",
    // Last day of month
    "2023-04-30T12:00:00Z",
    // First day of month
    "2023-05-01T00:00:01Z",
    // Last millisecond of year
    "2023-12-31T23:59:59.999Z",
    // First millisecond of year
    "2023-01-01T00:00:00.000Z",
    // Date in month with 31 days going back to month with 30 days
    "2023-08-31T12:00:00Z",
    // Date in month with 30 days going back to month with 31 days
    "2023-09-30T12:00:00Z",
    // February 28th in leap year (testing transition to January)
    "2024-02-28T12:00:00Z",
    // March 1st in leap year (testing transition from February)
    "2024-03-01T12:00:00Z",
    // December 31st going back to November 30th
    "2023-12-31T12:00:00Z",
    // January 31st going back to December 31st
    "2024-01-31T12:00:00Z",
    // Date exactly one week ago
    "2023-07-07T00:00:00Z",
    // Date exactly one month ago
    "2023-07-01T00:00:00Z",
    // Date exactly one year ago
    "2022-07-01T00:00:00Z",
    // Fall DST transition (November)
    "2023-11-05T01:00:00Z",
    // Spring DST transition (March)
    "2024-03-10T02:00:00Z",
    // Last day of February in non-leap year going to last day of January
    "2023-02-28T12:00:00Z",
    // Last day of February in leap year going to last day of January
    "2024-02-29T12:00:00Z",
  ] as const;

  for (const fixedDate of testDates) {
    describe(`with fixed date ${fixedDate}`, () => {
      // Mock the Date object to return the fixed date
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(dateString?: string) {
          if (dateString) {
            super();
            return new originalDate(dateString);
          }

          return new originalDate(fixedDate);
        }
      } as typeof Date;

      const boundaryDates = generateBoundaryDates();
      const boundaries = generateTestBoundaryDates(fixedDate);

      test("should return 'Today' for today's date", () => {
        const result = getDateGroup(boundaryDates, new Date(fixedDate));
        expect(result).toBe("Today");
      });

      test("should return 'Within the Last Week' for the latest date within the last week", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.latestLastWeek),
        );
        expect(result).toBe("Within the Last Week");
      });

      test("should return 'Within the Last Week' for the earliest date within the last week", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.earliestLastWeek),
        );
        expect(result).toBe("Within the Last Week");
      });

      test("should return 'Within the Last Month' for the latest date within the last month", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.latestLastMonth),
        );
        expect(result).toBe("Within the Last Month");
      });

      test("should return 'Within the Last Month' for the earliest date within the last month", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.earliestLastMonth),
        );
        expect(result).toBe("Within the Last Month");
      });

      test("should return 'Within the Last Year' for the latest date within the last year", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.latestLastYear),
        );
        expect(result).toBe("Within the Last Year");
      });

      test("should return 'Within the Last Year' for the earliest date within the last year", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.earliestLastYear),
        );
        expect(result).toBe("Within the Last Year");
      });

      test("should return 'Older' for the earliest date older than a year", () => {
        const result = getDateGroup(
          boundaryDates,
          new Date(boundaries.earliestOlder),
        );
        expect(result).toBe("Older");
      });

      // Restore the original Date object after each describe block
      afterAll(() => {
        global.Date = originalDate;
      });
    });
  }
});
