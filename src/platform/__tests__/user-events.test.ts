import { describe, expect, test } from "bun:test";
import {
  parseUserEvent,
  UserEventPublisher,
  userEventsChannel,
} from "#platform/user-events.ts";

describe("parseUserEvent", () => {
  test("parses valid user invalidation payloads", () => {
    expect(parseUserEvent(JSON.stringify({ userId: 42 }))).toEqual({
      userId: 42,
    });
  });

  test("rejects malformed payloads", () => {
    expect(parseUserEvent("not json")).toBeUndefined();
    expect(parseUserEvent(JSON.stringify({}))).toBeUndefined();
    expect(parseUserEvent(JSON.stringify({ userId: "42" }))).toBeUndefined();
    expect(parseUserEvent(JSON.stringify({ userId: 1.5 }))).toBeUndefined();
    expect(parseUserEvent("null")).toBeUndefined();
  });
});

test("UserEventPublisher publishes to the user-events channel", () => {
  const published: [string, string][] = [];
  const publisher = new UserEventPublisher({
    publish: async (channel, message) => {
      published.push([channel, message]);
      return 1;
    },
  });
  publisher.publish(7);
  expect(published).toEqual([[userEventsChannel, '{"userId":7}']]);
});
