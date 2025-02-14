import * as v from "valibot";

const allowedEmails =
  process.env["ALLOWED_EMAILS"]?.split(",").filter(Boolean) ?? [];

export const RegisterRequest = v.pipe(
  v.strictObject({
    email: v.pipe(
      v.string(),
      v.email(),
      allowedEmails.length > 0 ? v.picklist(allowedEmails) : v.trim(),
    ),
    password: v.string(),
    passwordConfirm: v.string(),
    username: v.string(),
  }),
  v.check((input) => {return input.password === input.passwordConfirm}),
);

export type RegisterRequest = v.InferOutput<typeof RegisterRequest>;
