import { createRequestHandler } from "$lib/create-request-handler";
import { json, type RequestHandler } from "@sveltejs/kit";
import type { Source } from "../../db/schemas/sources.ts";
import { updateSourceHandler } from "./handler.ts";
import { UpdateSourceRequest } from "./validator.ts";

type SortField =
  | keyof Pick<
      Source,
      "createdAt" | "recentFailures" | "lastAttempt" | "lastSuccess" | "url"
    >
  | "subscriberCount";

export const GET: RequestHandler = async ({ locals, url }) => {
  const sortBy = (url.searchParams.get("sortBy") ?? "createdAt") as SortField;
  const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";

  try {
    const sources = await locals.dependencies.sourcesDataService.listAllSources(
      sortBy === "subscriberCount" ? "id" : sortBy,
      order,
    );
    return json(sources);
  } catch {
    return json({ error: "Failed to fetch sources" }, { status: 500 });
  }
};

// Add the POST handler for updating the source
export const POST = createRequestHandler(
  UpdateSourceRequest,
  updateSourceHandler,
);
