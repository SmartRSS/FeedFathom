import * as v from "valibot";

const allowedEmails =
  process.env["ALLOWED_EMAILS"]?.split(",").filter(Boolean) ?? [];

export const RegisterRequest = v.pipe(
  v.strictObject({
    username: v.string(),
    email: v.pipe(
      v.string(),
      v.email(),
      allowedEmails.length > 0 ? v.picklist(allowedEmails) : v.trim(),
    ),
    password: v.string(),
    passwordConfirm: v.string(),
  }),
  v.check((input) => input.password === input.passwordConfirm),
);

export type RegisterRequest = v.InferOutput<typeof RegisterRequest>;
