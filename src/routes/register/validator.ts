import { z } from "zod";

const allowedEmails = process.env["ALLOWED_EMAILS"]?.split(",").filter(Boolean) ?? [];
export const registerRequestValidator = z
  .object({
    username: z.string(),
    email: z.string().email(),
    password: z.string(),
    passwordConfirm: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.password !== data.passwordConfirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Passwords don't match",
        path: ["passwordConfirm"],
      });
    }

    if (allowedEmails.length > 0 && !allowedEmails.includes(data.email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Email not allowed",
        path: ["email"],
      });
    }
  });
