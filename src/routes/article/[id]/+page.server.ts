import container from "../../../container";
import { error } from "@sveltejs/kit";

export const load = async ({ params }: { params: { id: string } }) => {
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
