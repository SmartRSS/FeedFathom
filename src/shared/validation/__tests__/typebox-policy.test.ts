import { Value } from "typebox/value";
import { expect, test } from "bun:test";
import {
  emailAddressPolicy,
  jsonDatePolicy,
  normalizedSubscriptionTarget,
  plainTextPolicy,
  webUrlPolicy,
} from "#shared/validation/typebox-policy.ts";

// withMatchingPasswords and withMatchingChangedPasswords are held to their
// contract at the routes that use them, in server-app.test.ts.
test("checks URL, email, plain-text, and internal-address policies", () => {
  expect(Value.Check(webUrlPolicy, "https://feed.example/rss")).toBe(true);
  expect(Value.Check(webUrlPolicy, "javascript:alert(1)")).toBe(false);
  expect(Value.Check(emailAddressPolicy, "reader@example.com")).toBe(true);
  expect(Value.Check(emailAddressPolicy, "reader@localhost")).toBe(false);
  expect(Value.Check(plainTextPolicy, "plain\ntext")).toBe(true);
  expect(Value.Check(plainTextPolicy, `bad${String.fromCharCode(0)}text`)).toBe(
    false,
  );
});

test.each([
  ["2026-07-29T12:34:56.789Z", true],
  ["not a date", false],
  ["2026-02-30T12:34:56.789Z", false],
  ["2026-07-29T12:34:56Z", false],
  ["2026-07-29T14:34:56.789+02:00", false],
  ["2026-07-29", false],
])("accepts only canonical JSON dates: %s", (value, accepted) => {
  expect(Value.Check(jsonDatePolicy, value)).toBe(accepted);
});

test("decodes validated subscription targets into a discriminator", () => {
  expect(
    Value.Decode(normalizedSubscriptionTarget, " newsletter@example.com "),
  ).toEqual({ kind: "email", value: "newsletter@example.com" });
  expect(
    Value.Decode(normalizedSubscriptionTarget, " https://feed.example/rss "),
  ).toEqual({ kind: "feed", value: "https://feed.example/rss" });
  expect(() =>
    Value.Decode(normalizedSubscriptionTarget, "not a subscription target"),
  ).toThrow();
});
