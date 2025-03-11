import { type InferOutput, number, strictObject } from "valibot";

export const DeleteFolder = strictObject({
  removeFolderId: number(),
});

export type DeleteFolder = InferOutput<typeof DeleteFolder>;
