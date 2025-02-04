import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "../$types";

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user; // Assuming user info is stored in locals
  if (!user.isAdmin) {
    return redirect(302, "/");
  }

  // Fetch sources for the admin panel
  const sources = await locals.dependencies.sourcesRepository.listAllSources(
    "created_at",
    "desc",
  );
  console.table(sources);

  if (!sources) {
    throw error(404, "Sources not found");
  }

  return {
    user,
    sources,
  };
};
