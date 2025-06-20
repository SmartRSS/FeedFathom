import { createRequestHandler } from "$lib/create-request-handler";
import { json, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import { deleteArticlesHandler } from "./handler.ts";
import { DeleteArticles } from "./validator.ts";

const isValidSourcesArray = (sources: unknown): sources is number[] => {
  return (
    Array.isArray(sources) &&
    sources.every((source) => {
      return typeof source === "number";
    })
  );
};

export const GET: RequestHandler = async ({ locals, url }: RequestEvent) => {
  if (!locals.user) {
    return json({
      error: "",
      status: 400,
      success: false,
    });
  }

  const sourcesList =
    url.searchParams.get("sources")?.split(",").map(Number) ?? [];
  if (!isValidSourcesArray(sourcesList) || sourcesList.length === 0) {
    return json([]);
  }

  const articles =
    await locals.dependencies.articlesDataService.getUserArticlesForSources(
      sourcesList,
      locals.user.id,
    );
  return json(articles);
};

export const DELETE: RequestHandler = createRequestHandler(
  DeleteArticles,
  deleteArticlesHandler,
);
