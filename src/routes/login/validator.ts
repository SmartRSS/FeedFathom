import { type InferOutput, email, pipe, strictObject, string } from "valibot";

export const LoginRequest = strictObject({
  email: pipe(string(), email()),
  password: string(),
});

export type LoginRequest = InferOutput<typeof LoginRequest>;
