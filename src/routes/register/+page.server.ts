import type { PageServerLoad } from "./$types.ts";

export const load: PageServerLoad = ({ locals }) => {
  const turnstileSiteKey = locals.dependencies.appConfig.TURNSTILE_SITE_KEY;
  return {
    turnstileSiteKey: turnstileSiteKey || null,
  };
};
