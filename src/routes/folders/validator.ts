import * as v from "valibot";

export const DeleteFolder = v.strictObject({
  removeFolderId: v.number(),
});

export type DeleteFolder = v.InferOutput<typeof DeleteFolder>;
