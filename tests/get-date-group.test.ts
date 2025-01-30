import { describe, expect, test } from "bun:test";
import { getDateGroup, generateBoundaryDates } from "../src/util/get-date-group"; // Adjust the import path as necessary

describe("getDateGroup", () => {
    // Define a structured dataset with relevant dates
    const testData = [{
        fixedDate: "2023-01-10T00:00:00Z", // Fixed date for testing
        earliestToday: "2023-01-10T00:00:00Z", // Earliest date that is today
        latestLastWeek: "2023-01-09T23:59:59Z", // Latest date within the last week
        earliestLastWeek: "2023-01-03T00:00:00Z", // Earliest date within the last week
        latestLastMonth: "2023-01-02T23:59:59Z", // Latest date within the last month
        earliestLastMonth: "2022-12-10T00:00:00Z", // Earliest date within the last month
        latestLastYear: "2022-12-09T23:59:59Z", // Latest date within the last year
        earliestLastYear: "2022-01-10T00:00:00Z", // Earliest date within the last year
        earliestOlder: "2022-01-09T24:59:59Z", // Earliest date older than a year
    },
    // {
    //     fixedDate: "2000-02-29T11:00:00Z", // Fixed date for testing
    //     earliestToday: "2000-02-29T00:00:00Z", // Earliest date that is today
    //     latestLastWeek: "2000-02-02T23:59:59Z", // Latest date within the last week
    //     earliestLastWeek: "2023-01-03T00:00:00Z", // Earliest date within the last week
    //     latestLastMonth: "2023-01-02T23:59:59Z", // Latest date within the last month
    //     earliestLastMonth: "2022-12-10T00:00:00Z", // Earliest date within the last month
    //     latestLastYear: "2022-12-09T23:59:59Z", // Latest date within the last year
    //     earliestLastYear: "2022-01-10T00:00:00Z", // Earliest date within the last year
    //     earliestOlder: "2022-01-09T24:59:59Z", // Earliest date older than a year
    // }
] as const;
    for (const dataset of testData) {
        // Mock the Date object to return the fixed date
        const originalDate = Date;
        global.Date = class extends originalDate {
            constructor(dateString?: string) {
                if (dateString) {
                    super();
                    return new originalDate(dateString);
                }
                return new originalDate(dataset.fixedDate);
            }
        } as any;

        const boundaryDates = generateBoundaryDates();

        // Test cases using the structured dataset
        test("should return 'Today' for today's date", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.fixedDate));
            expect(result).toBe("Today");
        });

        test("should return 'Within the Last Week' for the latest date within the last week", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.latestLastWeek));
            expect(result).toBe("Within the Last Week");
        });

        test("should return 'Within the Last Week' for the earliest date within the last week", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.earliestLastWeek));
            expect(result).toBe("Within the Last Week");
        });

        test("should return 'Within the Last Month' for the latest date within the last month", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.latestLastMonth));
            expect(result).toBe("Within the Last Month");
        });

        test("should return 'Within the Last Month' for the earliest date within the last month", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.earliestLastMonth));
            expect(result).toBe("Within the Last Month");
        });

        test("should return 'Within the Last Year' for the latest date within the last year", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.latestLastYear));
            expect(result).toBe("Within the Last Year");
        });

        test("should return 'Within the Last Year' for the earliest date within the last year", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.earliestLastYear));
            expect(result).toBe("Within the Last Year");
        });

        test("should return 'Older' for the earliest date older than a year", () => {
            const result = getDateGroup(boundaryDates, new Date(dataset.earliestOlder));
            expect(result).toBe("Older");
        });
        // Restore the original Date object
        global.Date = originalDate;
    }
});
