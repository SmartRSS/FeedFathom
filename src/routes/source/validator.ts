import { type InferOutput, number, strictObject } from "valibot";

export const DeleteSource = strictObject({
  removeSourceId: number(),
});

export type DeleteSource = InferOutput<typeof DeleteSource>;
