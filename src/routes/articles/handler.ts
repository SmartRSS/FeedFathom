import { type ValidatedRequestEvent } from "$lib/create-request-handler";
import { type DeleteArticles } from "./validator";
import { json } from "@sveltejs/kit";

export const deleteArticlesHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteArticles>) => {
  await locals.dependencies.articlesRepository.removeUserArticles(
    body.removedArticleIdList,
    locals.user.id,
  );

  return json(body.removedArticleIdList);
};
