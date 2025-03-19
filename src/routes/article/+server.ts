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

  const dbStartTime = performance.now();
  const article = await articlesRepository.getArticle(articleId);
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

  // Log the execution times
  // biome-ignore lint/suspicious/noConsoleLog: <explanation>
  // biome-ignore lint/suspicious/noConsole: <explanation>
  console.log({
    operation: "article_fetch",
    dbExecutionTime: `${dbExecutionTime.toFixed(2)}ms`,
    extractExecutionTime: `${extractExecutionTime.toFixed(2)}ms`,
    totalExecutionTime: `${(dbExecutionTime + extractExecutionTime).toFixed(2)}ms`,
  });

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
