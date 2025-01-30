import * as v from "valibot";
export const LoginRequest = v.strictObject({
  email: v.pipe(v.string(), v.email()),
  password: v.string(),
});

export type LoginRequest = v.InferOutput<typeof LoginRequest>;
