import { describe, expect, test } from "bun:test";
import { generateBoundaryDates } from "../src/util/get-date-group"; // Adjust the import path as necessary

describe("generateBoundaryDates", () => {
    const testCases = [
        {
            fixedDate: new Date("2020-02-29T00:00:00Z"), // Leap year
            expected: {
                today: new Date("2020-02-29T00:00:00Z"), // Today
                oneWeekAgo: new Date("2020-02-22T00:00:00Z"), // One week ago
                oneMonthAgo: new Date("2020-01-29T00:00:00Z"), // One month ago
                twoMonthsAgo: new Date("2019-12-29T00:00:00Z"), // Two months ago
                lastYear: new Date("2019-02-29T00:00:00Z"), // Last year (leap year)
            },
        },
        {
            fixedDate: new Date("2023-01-01T00:00:00Z"), // New Year
            expected: {
                today: new Date("2023-01-01T00:00:00Z"), // Today
                oneWeekAgo: new Date("2022-12-25T00:00:00Z"), // One week ago
                oneMonthAgo: new Date("2022-12-01T00:00:00Z"), // One month ago
                twoMonthsAgo: new Date("2022-11-01T00:00:00Z"), // Two months ago
                lastYear: new Date("2022-01-01T00:00:00Z"), // Last year
            },
        },
        {
            fixedDate: new Date("2000-01-01T00:00:00Z"), // Very old date
            expected: {
                today: new Date("2000-01-01T00:00:00Z"), // Today
                oneWeekAgo: new Date("1999-12-25T00:00:00Z"), // One week ago
                oneMonthAgo: new Date("1999-12-01T00:00:00Z"), // One month ago
                twoMonthsAgo: new Date("1999-11-01T00:00:00Z"), // Two months ago
                lastYear: new Date("1999-01-01T00:00:00Z"), // Last year
            },
        },
    ];

    testCases.forEach(({ fixedDate, expected }) => {
        test(`should generate correct boundary dates for ${fixedDate.toISOString()}`, () => {
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
            } as any;

            const boundaryDates = generateBoundaryDates();
            global.Date = originalDate;

            expect(boundaryDates).toEqual(expected);
        });
    });
});
