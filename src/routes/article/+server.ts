import { json, type RequestHandler } from "@sveltejs/kit";
import { extractArticle } from "$lib/extract-article";
import { DisplayMode } from "$lib/settings";

export const GET: RequestHandler = async ({ locals, url }) => {
  const articlesDataService = locals.dependencies.articlesDataService;

  const articleIdParameter = url.searchParams.get("article");
  if (!articleIdParameter) {
    return json({}, { status: 404 });
  }

  const articleId = Number.parseInt(articleIdParameter, 10);

  const dbStartTime = performance.now();
  const article = await articlesDataService.getArticle(articleId);
  const dbEndTime = performance.now();
  const dbExecutionTime = dbEndTime - dbStartTime;

  if (!article) {
    return json({}, { status: 404 });
  }

  const displayMode = (url.searchParams.get("displayMode") ??
    DisplayMode.Feed) as DisplayMode;

  const extractStartTime = performance.now();
  const extractedArticle = await extractArticle(
    article.content,
    article.url,
    displayMode,
  );
  const extractEndTime = performance.now();
  const extractExecutionTime = extractEndTime - extractStartTime;

  return json(
    {
      ...article,
      content: extractedArticle,
    },
    {
      headers: {
        "Server-Timing": `db;dur=${dbExecutionTime},extract;dur=${extractExecutionTime}`,
        "X-Response-Time": `${(dbExecutionTime + extractExecutionTime).toFixed(2)}ms`,
        "X-Request-ID": crypto.randomUUID(),
        "X-Origin-Region": process.env["CF_REGION"] || "unknown",
        "X-Origin-IP": process.env["CF_CONNECTING_IP"] || "unknown",
      },
    },
  );
};
