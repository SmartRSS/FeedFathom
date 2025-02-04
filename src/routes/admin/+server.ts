import { json, type RequestHandler } from "@sveltejs/kit";

type SortField =
  | "url"
  | "subscriber_count"
  | "created_at"
  | "last_attempt"
  | "last_success"
  | "recent_failures";

export const GET: RequestHandler = async ({ locals, url }) => {
  const sortBy: SortField =
    (url.searchParams.get("sortBy") as SortField) || "created_at"; // Default sort field
  const order: "asc" | "desc" =
    (url.searchParams.get("order") as "asc" | "desc") || "asc"; // Default order

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
