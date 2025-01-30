import { json, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import { createRequestHandler } from "$lib/create-request-handler";
import { DeleteArticles } from "./validator";
import { deleteArticlesHandler } from "./handler";

function isValidSourcesArray(sources: unknown): sources is number[] {
  return (
    Array.isArray(sources) &&
    sources.every((source) => typeof source === "number")
  );
}

export const GET: RequestHandler = async ({ url, locals }: RequestEvent) => {
  const startTime = new Date().valueOf();
  const sourcesList =
    url.searchParams.get("sources")?.split(",").map(Number) ?? [];
  if (!isValidSourcesArray(sourcesList) || sourcesList.length === 0) {
    return json([]);
  }
  const articles =
    await locals.dependencies.articlesRepository.getUserArticlesForSources(
      sourcesList,
      locals.user.id,
    );
  console.log("time", new Date().valueOf() - startTime);
  return json(articles);
};

export const DELETE: RequestHandler = createRequestHandler(
  DeleteArticles,
  deleteArticlesHandler,
);
