import { redirect } from "@sveltejs/kit";

export const load = async ({ locals }: { locals: App.Locals }) => {
  const user = locals.user;
  if (!user?.isAdmin) {
    return redirect(302, "/");
  }

  // Fetch sources for the admin panel
  const sources = await locals.dependencies.sourcesRepository.listAllSources(
    "created_at",
    "desc",
  );

  return {
    sources,
    user,
  };
};
