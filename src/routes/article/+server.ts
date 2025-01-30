import { json, type RequestHandler } from "@sveltejs/kit";
import { DisplayMode } from "$lib/settings";
import { extractArticle } from "$lib/extract-article";

export const GET: RequestHandler = async ({ url, locals }) => {
  const articlesRepository = locals.dependencies.articlesRepository;

  const articleIdParameter = url?.searchParams?.get("article");
  if (!articleIdParameter) {
    return json({}, { status: 404 });
  }
  const articleId = Number.parseInt(articleIdParameter);

  const article = await articlesRepository.getArticle(articleId);
  if (!article) {
    return json({}, { status: 404 });
  }

  const displayMode =
    (url?.searchParams?.get("displayMode") as DisplayMode) || DisplayMode.FEED;

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
