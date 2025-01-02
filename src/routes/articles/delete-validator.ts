import { z } from "zod";

export const deleteArticlesValidator = z.object({
  removedArticleIdList: z.array(z.number()),
});

export type DeleteArticlesBody = z.infer<typeof deleteArticlesValidator>;
