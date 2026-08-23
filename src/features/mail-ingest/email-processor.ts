import { Type } from "typebox";
import Schema from "typebox/schema";
import { dateType } from "#shared/validation/typebox-policy.ts";

const externalProjection = { additionalProperties: true } as const;
const parsedMailProjection = Type.Object(
  {
    date: Type.Optional(Type.Union([dateType, Type.Undefined()])),
    html: Type.Union([Type.String(), Type.Literal(false)]),
    subject: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    textAsHtml: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  },
  externalProjection,
);
const parsedMailProjectionCheck = Schema.Compile(parsedMailProjection);

export function validateParsedMail(value: unknown) {
  if (!parsedMailProjectionCheck.Check(value)) {
    throw new Error("Mail parser returned an invalid message projection");
  }
  return value;
}

export const getEmailContent = (email: unknown): string => {
  const parsed = validateParsedMail(email);
  if (typeof parsed.html === "string") return parsed.html;
  return parsed.textAsHtml ?? "No content.";
};
