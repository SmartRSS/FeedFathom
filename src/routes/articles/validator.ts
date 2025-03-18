import { type } from "arktype";

export const DeleteArticles = type({
  removedArticleIdList: "number[]",
  "+": "reject",
});

export type DeleteArticles = typeof DeleteArticles.infer;
