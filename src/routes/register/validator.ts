import {
  type InferOutput,
  check,
  email,
  picklist,
  pipe,
  strictObject,
  string,
  trim,
} from "valibot";

const allowedEmails =
  process.env["ALLOWED_EMAILS"]?.split(",").filter(Boolean) ?? [];

export const RegisterRequest = pipe(
  strictObject({
    email: pipe(
      string(),
      email(),
      allowedEmails.length > 0 ? picklist(allowedEmails) : trim(),
    ),
    password: string(),
    passwordConfirm: string(),
    username: string(),
  }),
  check((input) => {
    return input.password === input.passwordConfirm;
  }),
);

export type RegisterRequest = InferOutput<typeof RegisterRequest>;
