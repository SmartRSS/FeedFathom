import { Type } from "typebox";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import { describe, expect, test } from "bun:test";
import {
  disposableEmailPolicy,
  emailAddressPolicy,
  jsonDatePolicy,
  normalizedSubscriptionTarget,
  plainTextPolicy,
  webUrlPolicy,
  withMatchingChangedPasswords,
  withMatchingPasswords,
} from "#shared/validation/typebox-policy.ts";

const registration = withMatchingPasswords(
  Type.Object({
    password: Type.String(),
    passwordConfirm: Type.String(),
  }),
);

describe("matchingPasswordsPolicy", () => {
  test("enforces matching passwords with Value and compiled validation", () => {
    const compiled = Schema.Compile(registration);
    const matching = { password: "secret", passwordConfirm: "secret" };
    const mismatched = { password: "secret", passwordConfirm: "different" };

    expect(Value.Check(registration, matching)).toBe(true);
    expect(Value.Check(registration, mismatched)).toBe(false);
    expect(compiled.Check(matching)).toBe(true);
    expect(compiled.Check(mismatched)).toBe(false);
  });
});

test("enforces password-change equality", () => {
  const passwordChange = withMatchingChangedPasswords(
    Type.Object({ password1: Type.String(), password2: Type.String() }),
  );

  expect(
    Value.Check(passwordChange, { password1: "same", password2: "same" }),
  ).toBe(true);
  expect(
    Value.Check(passwordChange, { password1: "same", password2: "different" }),
  ).toBe(false);
});

test("checks URL, email, plain-text, and internal-address policies", () => {
  expect(Value.Check(webUrlPolicy, "https://feed.example/rss")).toBe(true);
  expect(Value.Check(webUrlPolicy, "javascript:alert(1)")).toBe(false);
  expect(Value.Check(emailAddressPolicy, "reader@example.com")).toBe(true);
  expect(Value.Check(emailAddressPolicy, "reader@localhost")).toBe(false);
  expect(Value.Check(disposableEmailPolicy, "reader@mailinator.com")).toBe(
    true,
  );
  expect(Value.Check(disposableEmailPolicy, "reader@example.com")).toBe(false);
  expect(Value.Check(plainTextPolicy, "plain\ntext")).toBe(true);
  expect(Value.Check(plainTextPolicy, `bad${String.fromCharCode(0)}text`)).toBe(
    false,
  );
});

test("accepts canonical JSON dates", () => {
  expect(Value.Check(jsonDatePolicy, "2026-07-29T12:34:56.789Z")).toBe(true);
});

test.each([
  "not a date",
  "2026-02-30T12:34:56.789Z",
  "2026-07-29T12:34:56Z",
  "2026-07-29T14:34:56.789+02:00",
  "2026-07-29",
])("rejects noncanonical JSON date %s", (value) => {
  expect(Value.Check(jsonDatePolicy, value)).toBe(false);
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
