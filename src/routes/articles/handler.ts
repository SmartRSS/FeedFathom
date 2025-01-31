import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { DeleteArticles } from "./validator";

export const deleteArticlesHandler = async ({
  locals,
  body,
}: ValidatedRequestEvent<DeleteArticles>) => {
  await locals.dependencies.articlesRepository.removeUserArticles(
    body.removedArticleIdList,
    locals.user.id,
  );

  return json(body.removedArticleIdList);
};
