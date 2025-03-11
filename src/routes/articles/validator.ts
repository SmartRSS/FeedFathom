import { type InferOutput, array, number, strictObject } from "valibot";

export const DeleteArticles = strictObject({
  removedArticleIdList: array(number()),
});

export type DeleteArticles = InferOutput<typeof DeleteArticles>;
