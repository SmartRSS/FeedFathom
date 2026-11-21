import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  isEmailAddress,
  isWebUrl,
  maxEmailAddressLength,
} from "./address-shape.ts";

type SubscriptionTarget =
  | { kind: "email"; value: string }
  | { kind: "feed"; value: string };

const nonblankString = Type.String({ minLength: 1, pattern: "\\S" });

export const dateType = Type.Refine(
  Type.Unsafe<Date>(Type.Unknown()),
  (value) => value instanceof Date,
);

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
const nonPrintablePattern = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F]/u;
export const plainTextPolicy = Type.Refine(
  Type.String(),
  (value) => !nonPrintablePattern.test(value),
);
export const jsonDatePolicy = Type.Refine(Type.String(), (value) => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toJSON() === value;
});

export const normalizedNonblankString = Type.Codec(nonblankString)
  .Decode((value) => value.trim())
  .Encode((value) => value);

export const normalizedWebUrl = Type.Codec(
  Type.Refine(nonblankString, isWebUrl),
)
  .Decode((value) => value.trim())
  .Encode((value) => value);

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
    return isEmailAddress(normalized)
      ? { kind: "email", value: normalized.toLowerCase() }
      : { kind: "feed", value: normalized };
  })
  .Encode((value) => value.value);
