import * as v from "valibot";

export const UpdateSourceRequest = v.strictObject({
  oldUrl: v.string(),
  newUrl: v.string(),
});

export type UpdateSourceRequest = v.InferOutput<typeof UpdateSourceRequest>;
