import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const turnstileSiteKey = locals.dependencies.appConfig.TURNSTILE_SITE_KEY;
  return {
    turnstileSiteKey: turnstileSiteKey || null,
  };
};
