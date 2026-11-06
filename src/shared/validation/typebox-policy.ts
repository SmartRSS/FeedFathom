import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { isPlainText } from "#shared/util/is-plain-text.ts";
import {
  isEmailAddress,
  isWebUrl,
  maxEmailAddressLength,
} from "./address-shape.ts";

type SubscriptionTarget =
  | { kind: "email"; value: string }
  | { kind: "feed"; value: string };

const nonblankString = Type.String({ minLength: 1, pattern: "\\S" });

// typebox dropped the non-JSON-Schema Type.Date() builtin; this replicates
// its runtime `instanceof Date` check for in-memory (not over-the-wire)
// validation of real Date objects.
export const dateType = Type.Refine(
  Type.Unsafe<Date>(Type.Unknown()),
  (value) => value instanceof Date,
);

// Both password forms carry the same rule under different field names, so
// the pair to compare is a parameter rather than a second copy of the check.
function withEqualStrings<T extends TSchema>(
  schema: T,
  first: string,
  second: string,
) {
  const projection = Type.Object(
    { [first]: Type.String(), [second]: Type.String() },
    { additionalProperties: true },
  );
  return Type.Refine(schema, (value) => {
    if (!Value.Check(projection, value)) return false;
    return value[first] === value[second];
  });
}

export function withMatchingPasswords<T extends TSchema>(schema: T) {
  return withEqualStrings(schema, "password", "passwordConfirm");
}

export function withMatchingChangedPasswords<T extends TSchema>(schema: T) {
  return withEqualStrings(schema, "password1", "password2");
}

export const webUrlPolicy = Type.Refine(Type.String(), isWebUrl);
export const plainTextPolicy = Type.Refine(Type.String(), isPlainText);
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

// The cap matters beyond mail: the address is part of the auth throttle's
// Redis keys, and an unbounded one lets each request park up to the body limit
// in Redis.
export const normalizedEmailAddress = Type.Codec(
  Type.Refine(
    nonblankString,
    (value) =>
      isEmailAddress(value) && value.trim().length <= maxEmailAddressLength,
  ),
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
    // Newsletter addresses are matched against the envelope recipient of
    // inbound mail with an exact comparison, so both sides canonicalise to
    // lowercase. A feed URL keeps its case: its path is case-sensitive.
    return isEmailAddress(normalized)
      ? { kind: "email", value: normalized.toLowerCase() }
      : { kind: "feed", value: normalized };
  })
  .Encode((value) => value.value);
