import { z } from "zod";

export const deleteFolderValidator = z.object({
  removeFolderId: z.number(),
});

export type DeleteFolderBody = z.infer<typeof deleteFolderValidator>;
