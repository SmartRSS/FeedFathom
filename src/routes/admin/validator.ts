import { type InferOutput, strictObject, string } from "valibot";

export const UpdateSourceRequest = strictObject({
  newUrl: string(),
  oldUrl: string(),
});

export type UpdateSourceRequest = InferOutput<typeof UpdateSourceRequest>;
