import { json, type RequestHandler } from "@sveltejs/kit";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { DisplayMode } from "$lib/settings";

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
  if (displayMode === DisplayMode.FEED) {
    return json(article);
  }

  const response = await locals.dependencies.axiosInstance.get(article.url);
  const doc = new JSDOM(response.data, { url: article.url });
  if (
    [DisplayMode.READABILITY, DisplayMode.READABILITY_PLAIN].includes(
      displayMode,
    )
  ) {
    const reader = new Readability(doc.window.document);
    const parsedArticle = reader.parse();

    if (!parsedArticle) {
      return json(article);
    }

    return json({
      ...article,
      content:
        displayMode === DisplayMode.READABILITY
          ? parsedArticle.content
          : parsedArticle.textContent,
    });
  }
  return json(article);
};
