import { describe, expect, test } from "bun:test";
import { settingsFrom } from "../settings.ts";

describe("settingsFrom", () => {
  test("reads stored values", () => {
    expect(
      settingsFrom({
        instance: "https://reader.example",
        showBadge: false,
        showOpenRss: true,
      }),
    ).toEqual({
      instance: "https://reader.example",
      showBadge: false,
      showOpenRss: true,
    });
  });

  test("an empty store means no instance, badge on, OpenRSS off", () => {
    expect(settingsFrom({})).toEqual({
      instance: undefined,
      showBadge: true,
      showOpenRss: false,
    });
  });

  test("an unreadable value falls back to its own default only", () => {
    expect(
      settingsFrom({ instance: 1, showBadge: 0, showOpenRss: "on" }),
    ).toEqual({ instance: undefined, showBadge: true, showOpenRss: false });
    expect(
      settingsFrom({ instance: "https://reader.example", showBadge: "off" }),
    ).toMatchObject({ instance: "https://reader.example", showBadge: true });
  });
});
