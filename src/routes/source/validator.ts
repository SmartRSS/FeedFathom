import * as v from "valibot";

export const DeleteSource = v.strictObject({
  removeSourceId: v.number(),
});

export type DeleteSource = v.InferOutput<typeof DeleteSource>;
