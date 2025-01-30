import * as v from "valibot";

export const DeleteArticles = v.strictObject({
  removedArticleIdList: v.array(v.number()),
});

export type DeleteArticles = v.InferOutput<typeof DeleteArticles>;
