import { generateBoundaryDates } from "../src/util/get-date-group";
import { describe, expect, test } from "bun:test";

describe("generateBoundaryDates", () => {
  const testCases = [
    {
      expected: {
        lastYear: new Date("2019-02-29T00:00:00Z"),
        oneMonthAgo: new Date("2020-01-29T00:00:00Z"),
        oneWeekAgo: new Date("2020-02-22T00:00:00Z"),
        today: new Date("2020-02-29T00:00:00Z"),
        twoMonthsAgo: new Date("2019-12-29T00:00:00Z"),
      },
      fixedDate: new Date("2020-02-29T00:00:00Z"),
    },
    {
      expected: {
        lastYear: new Date("2022-01-01T00:00:00Z"),
        oneMonthAgo: new Date("2022-12-01T00:00:00Z"),
        oneWeekAgo: new Date("2022-12-25T00:00:00Z"),
        today: new Date("2023-01-01T00:00:00Z"),
        twoMonthsAgo: new Date("2022-11-01T00:00:00Z"),
      },
      fixedDate: new Date("2023-01-01T00:00:00Z"),
    },
    {
      expected: {
        lastYear: new Date("1999-01-01T00:00:00Z"),
        oneMonthAgo: new Date("1999-12-01T00:00:00Z"),
        oneWeekAgo: new Date("1999-12-25T00:00:00Z"),
        today: new Date("2000-01-01T00:00:00Z"),
        twoMonthsAgo: new Date("1999-11-01T00:00:00Z"),
      },
      fixedDate: new Date("2000-01-01T00:00:00Z"),
    },
  ];

  for (const { expected, fixedDate } of testCases) {
    test(`should generate correct boundary dates for ${fixedDate.toISOString()}`, () => {
      // Mock the Date object to return the fixed date
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(dateString?: string) {
          if (dateString) {
            super();
            // eslint-disable-next-line no-constructor-return
            return new originalDate(dateString);
          }

          // eslint-disable-next-line no-constructor-return
          return new originalDate(fixedDate);
        }
      } as typeof Date;

      const boundaryDates = generateBoundaryDates();
      global.Date = originalDate;

      expect(boundaryDates).toEqual(expected);
    });
  }
});
