import { type } from "arktype";
import { config } from "../../config.ts";

export const RegisterRequest = type({
  username: "string",
  email: "string.email",
  password: "string",
  passwordConfirm: "string",
  "cf-turnstile-response?": "string",
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
    if (
      config["ALLOWED_EMAILS"].length > 0 &&
      !config["ALLOWED_EMAILS"].includes(n.email)
    ) {
      ctx.mustBe("Email is not allowed");
      return false;
    }
    return true;
  });

export type RegisterRequest = typeof RegisterRequest.infer;
