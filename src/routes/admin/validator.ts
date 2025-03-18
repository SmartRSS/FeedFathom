import { type } from "arktype";

export const UpdateSourceRequest = type({
  newUrl: type.string,
  oldUrl: type.string,
  "+": "reject",
});

export type UpdateSourceRequest = typeof UpdateSourceRequest.infer;
