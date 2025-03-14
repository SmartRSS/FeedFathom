import { extractArticle } from "$lib/extract-article";
import { DisplayMode } from "$lib/settings";
import { type RequestHandler, json } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ locals, url }) => {
  const articlesRepository = locals.dependencies.articlesRepository;

  const articleIdParameter = url.searchParams.get("article");
  if (!articleIdParameter) {
    return json({}, { status: 404 });
  }

  const articleId = Number.parseInt(articleIdParameter, 10);

  const article = await articlesRepository.getArticle(articleId);
  if (!article) {
    return json({}, { status: 404 });
  }

  const displayMode = (url.searchParams.get("displayMode") ??
    DisplayMode.Feed) as DisplayMode;

  const extractedArticle = await extractArticle(
    article.content,
    article.url,
    displayMode,
  );

  return json({
    ...article,
    content: extractedArticle,
  });
};
