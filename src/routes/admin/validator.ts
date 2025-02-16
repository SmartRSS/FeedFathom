import * as v from "valibot";

export const UpdateSourceRequest = v.strictObject({
  newUrl: v.string(),
  oldUrl: v.string(),
});

export type UpdateSourceRequest = v.InferOutput<typeof UpdateSourceRequest>;
