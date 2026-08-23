import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { isDisposableEmail } from "disposable-email-domains-js";
import { isPlainText } from "../../util/is-plain-text.ts";

type PasswordPair = {
  password: string;
  passwordConfirm: string;
};

type PasswordChange = {
  password1: string;
  password2: string;
};

type SubscriptionTarget =
  | { kind: "email"; value: string }
  | { kind: "feed"; value: string };

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const nonblankString = Type.String({ minLength: 1, pattern: "\\S" });
const passwordPairProjection = Type.Object(
  { password: Type.String(), passwordConfirm: Type.String() },
  { additionalProperties: true },
);
const passwordChangeProjection = Type.Object(
  { password1: Type.String(), password2: Type.String() },
  { additionalProperties: true },
);

function isWebUrl(value: string) {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isEmailAddress(value: string) {
  return emailPattern.test(value.trim());
}

// typebox dropped the non-JSON-Schema Type.Date() builtin; this replicates
// its runtime `instanceof Date` check for in-memory (not over-the-wire)
// validation of real Date objects.
export const dateType = Type.Refine(
  Type.Unsafe<Date>(Type.Unknown()),
  (value) => value instanceof Date,
);

export function withMatchingPasswords<T extends TSchema>(schema: T) {
  return Type.Refine(schema, (value) => {
    if (!Value.Check(passwordPairProjection, value)) return false;
    return (
      (value as PasswordPair).password ===
      (value as PasswordPair).passwordConfirm
    );
  });
}

export function withMatchingChangedPasswords<T extends TSchema>(schema: T) {
  return Type.Refine(schema, (value) => {
    if (!Value.Check(passwordChangeProjection, value)) return false;
    return (
      (value as PasswordChange).password1 ===
      (value as PasswordChange).password2
    );
  });
}

export const webUrlPolicy = Type.Refine(Type.String(), isWebUrl);
export const emailAddressPolicy = Type.Refine(Type.String(), isEmailAddress);
export const disposableEmailPolicy = Type.Refine(Type.String(), (value) =>
  isDisposableEmail(value.trim()),
);
export const plainTextPolicy = Type.Refine(Type.String(), isPlainText);
export const internalAddressPolicy = Type.Refine(
  Type.String(),
  (value) =>
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1",
);
export const jsonDatePolicy = Type.Refine(
  Type.String(),
  (value) =>
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toJSON() === value,
);

export const normalizedNonblankString = Type.Codec(nonblankString)
  .Decode((value) => value.trim())
  .Encode((value) => value);

export const normalizedWebUrl = Type.Codec(
  Type.Refine(nonblankString, isWebUrl),
)
  .Decode((value) => value.trim())
  .Encode((value) => value);

export const normalizedEmailAddress = Type.Codec(
  Type.Refine(nonblankString, isEmailAddress),
)
  .Decode((value) => value.trim())
  .Encode((value) => value);

export const normalizedSubscriptionTarget = Type.Codec(
  Type.Refine(
    nonblankString,
    (value) => isEmailAddress(value) || isWebUrl(value),
  ),
)
  .Decode((value): SubscriptionTarget => {
    const normalized = value.trim();
    return isEmailAddress(normalized)
      ? { kind: "email", value: normalized }
      : { kind: "feed", value: normalized };
  })
  .Encode((value) => value.value);

export type { SubscriptionTarget };
