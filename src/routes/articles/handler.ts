import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { DeleteArticles } from "./validator";

export const deleteArticlesHandler = async ({
  locals,
  request,
}: ValidatedRequestEvent<DeleteArticles>) => {
  await locals.dependencies.articlesRepository.removeUserArticles(
    request.body.removedArticleIdList,
    locals.user.id,
  );

  return json(request.body.removedArticleIdList);
};
