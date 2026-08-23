import { describe, expect, test } from "bun:test";
import { generateBoundaryDates } from "#shared/util/get-date-group.ts";

describe("generateBoundaryDates", () => {
  const cases = [
    {
      expected: {
        lastYear: new Date(2023, 2, 1),
        oneMonthAgo: new Date(2024, 0, 29),
        oneWeekAgo: new Date(2024, 1, 22),
        today: new Date(2024, 1, 29),
      },
      now: new Date(2024, 1, 29, 12, 30),
    },
    {
      expected: {
        lastYear: new Date(2022, 0, 1),
        oneMonthAgo: new Date(2022, 11, 1),
        oneWeekAgo: new Date(2022, 11, 25),
        today: new Date(2023, 0, 1),
      },
      now: new Date(2023, 0, 1, 23, 59),
    },
    {
      expected: {
        lastYear: new Date(2023, 2, 31),
        oneMonthAgo: new Date(2024, 2, 2),
        oneWeekAgo: new Date(2024, 2, 24),
        today: new Date(2024, 2, 31),
      },
      now: new Date(2024, 2, 31, 8),
    },
  ];

  for (const { expected, now } of cases) {
    test(`generates local boundaries for ${now.toString()}`, () => {
      expect(generateBoundaryDates(now)).toEqual(expected);
    });
  }
});
