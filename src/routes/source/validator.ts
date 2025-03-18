import { type } from "arktype";

export const DeleteSource = type({
  removeSourceId: "number",
  "+": "reject",
});

export type DeleteSource = typeof DeleteSource.infer;
