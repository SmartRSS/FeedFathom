import type { ServerLoad } from "@sveltejs/kit";

export const load: ServerLoad = ({ locals }) => {
  const turnstileSiteKey = locals.dependencies.appConfig.TURNSTILE_SITE_KEY;
  return {
    turnstileSiteKey: turnstileSiteKey || null,
  };
};
