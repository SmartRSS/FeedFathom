import { error } from "@sveltejs/kit";
import container from "../../../container.ts";

export const load = async ({ params }: { params: { id: string } }) => {
  const article = await container.cradle.articlesDataService.getArticleByGuid(
    params.id,
  );

  if (!article) {
    throw error(404, "Article not found");
  }

  return {
    article,
  };
};
