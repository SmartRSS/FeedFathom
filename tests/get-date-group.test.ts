import { expect, test } from "bun:test";
import {
  generateBoundaryDates,
  getDateGroup,
} from "../src/util/get-date-group.ts";

const cases: [Date, Date, string][] = [
  [new Date(2024, 6, 15, 14), new Date(2024, 6, 15), "Today"],
  [new Date(2024, 6, 15, 14), new Date(2024, 6, 15, 23, 59), "Today"],
  [new Date(2024, 6, 15, 14), new Date(2024, 6, 8), "Within the Last Week"],
  [
    new Date(2024, 6, 15, 14),
    new Date(2024, 6, 7, 23, 59),
    "Within the Last Month",
  ],
  [new Date(2024, 6, 15, 14), new Date(2024, 5, 15), "Within the Last Month"],
  [
    new Date(2024, 6, 15, 14),
    new Date(2024, 5, 14, 23, 59),
    "Within the Last Year",
  ],
  [new Date(2024, 6, 15, 14), new Date(2023, 6, 15), "Within the Last Year"],
  [new Date(2024, 6, 15, 14), new Date(2023, 6, 14, 23, 59), "Older"],
  [new Date(2024, 1, 29, 12), new Date(2024, 1, 22), "Within the Last Week"],
  [
    new Date(2024, 1, 29, 12),
    new Date(2024, 1, 21, 23, 59),
    "Within the Last Month",
  ],
  [new Date(2024, 1, 29, 12), new Date(2024, 0, 29), "Within the Last Month"],
  [
    new Date(2024, 1, 29, 12),
    new Date(2024, 0, 28, 23, 59),
    "Within the Last Year",
  ],
  [new Date(2024, 1, 29, 12), new Date(2023, 2, 1), "Within the Last Year"],
  [new Date(2024, 1, 29, 12), new Date(2023, 1, 28, 23, 59), "Older"],
  [new Date(2024, 2, 31, 12), new Date(2024, 2, 2), "Within the Last Month"],
  [
    new Date(2024, 2, 31, 12),
    new Date(2024, 2, 1, 23, 59),
    "Within the Last Year",
  ],
];

test("groups explicit local dates across calendar boundaries", () => {
  for (const [now, publishedAt, expected] of cases) {
    expect(getDateGroup(generateBoundaryDates(now), publishedAt)).toBe(
      expected,
    );
  }
});
