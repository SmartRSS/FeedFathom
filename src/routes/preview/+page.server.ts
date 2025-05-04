import { getMailFeatureState } from "../../util/is-mail-enabled.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const { appConfig } = locals.dependencies;
  const mailFeatureState = getMailFeatureState(appConfig);
  return {
    isMailEnabled: mailFeatureState.enabled,
    mailFeatureState,
  };
};
