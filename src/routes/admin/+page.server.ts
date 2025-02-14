import { type PageServerLoad } from "../$types";
import { redirect } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user; // Assuming user info is stored in locals
  if (!user?.isAdmin) {
    return redirect(302, "/");
  }

  // Fetch sources for the admin panel
  const sources = await locals.dependencies.sourcesRepository.listAllSources(
    "created_at",
    "desc",
  );
  console.table(sources);

  return {
    sources,
    user,
  };
};
