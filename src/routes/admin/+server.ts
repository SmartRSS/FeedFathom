import { createRequestHandler } from "$lib/create-request-handler";
import { updateSourceHandler } from "./handler";
import { UpdateSourceRequest } from "./validator";
import { json, type RequestHandler } from "@sveltejs/kit";

type SortField =
  | "created_at"
  | "failures"
  | "last_attempt"
  | "last_success"
  | "subscriber_count"
  | "url";

export const GET: RequestHandler = async ({ locals, url }) => {
  const sortBy = (url.searchParams.get("sortBy") ?? "created_at") as SortField;
  const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";

  try {
    const sources = await locals.dependencies.sourcesRepository.listAllSources(
      sortBy,
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
