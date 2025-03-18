import { type } from "arktype";

const allowedEmails =
  process.env["ALLOWED_EMAILS"]?.split(",").filter(Boolean) ?? [];

export const RegisterRequest = type({
  email: "string.email",
  password: "string",
  passwordConfirm: "string",
  username: "string",
  "+": "reject",
})
  .narrow((n, ctx) => {
    if (n.password !== n.passwordConfirm) {
      ctx.mustBe("Passwords do not match");
      return false;
    }
    return true;
  })
  .narrow((n, ctx) => {
    if (!allowedEmails.includes(n.email)) {
      ctx.mustBe("Email is not allowed");
      return false;
    }
    return true;
  });

export type RegisterRequest = typeof RegisterRequest.infer;
