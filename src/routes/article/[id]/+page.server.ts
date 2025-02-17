import container from "../../../container";
import { type RouteParams as RouteParameters } from "./$types";
import { error } from "@sveltejs/kit";

export const load = async ({ params }: { params: RouteParameters }) => {
  const article = await container.cradle.articlesRepository.getArticleByGuid(
    params.id,
  );

  if (!article) {
    throw error(404, "Article not found");
  }

  return {
    article,
  };
};
