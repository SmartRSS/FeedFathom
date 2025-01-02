import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { DeleteArticlesBody } from "./delete-validator";

export const deleteArticlesHandler = async ({
  locals,
  request,
}: ValidatedRequestEvent<DeleteArticlesBody>) => {
  await locals.dependencies.articlesRepository.removeUserArticles(
    request.body.removedArticleIdList,
    locals.user.id,
  );

  return json(request.body.removedArticleIdList);
};
