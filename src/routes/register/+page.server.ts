import type { ServerLoad } from "@sveltejs/kit";

type RegistrationStatus = "FIRST_USER" | "ENABLED" | "DISABLED";

export const load: ServerLoad = async ({ locals }) => {
  const { appConfig, usersDataService } = locals.dependencies;
  const turnstileSiteKey = appConfig.TURNSTILE_SITE_KEY;

  const userCount = await usersDataService.getUserCount();
  const registrationEnabled = appConfig.ENABLE_REGISTRATION;

  let registrationStatus: RegistrationStatus;

  if (userCount === 0) {
    registrationStatus = "FIRST_USER";
  } else if (registrationEnabled) {
    registrationStatus = "ENABLED";
  } else {
    registrationStatus = "DISABLED";
  }

  return {
    turnstileSiteKey: turnstileSiteKey ?? null,
    registrationStatus,
  };
};
