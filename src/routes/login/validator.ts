import { type } from "arktype";

export const LoginRequest = type({
  email: "string",
  password: "string",
  "+": "reject",
});

export type LoginRequest = typeof LoginRequest.infer;
