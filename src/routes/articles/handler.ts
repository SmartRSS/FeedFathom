import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import { json } from "@sveltejs/kit";
import type { DeleteArticles } from "./validator.ts";

export const deleteArticlesHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteArticles>) => {
  await locals.dependencies.articlesDataService.removeUserArticles(
    body.removedArticleIdList,
    locals.user.id,
  );

  return json(body.removedArticleIdList);
};
