import { json, type RequestHandler } from "@sveltejs/kit";

type SortField =
  | "url"
  | "subscriber_count"
  | "created_at"
  | "last_attempt"
  | "last_success"
  | "failures";

export const GET: RequestHandler = async ({ locals, url }) => {
  const sortBy = (url.searchParams.get("sortBy") || "created_at") as SortField; // Default sort field
  const order = (url.searchParams.get("order") || "asc") as "asc" | "desc"; // Default order

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
