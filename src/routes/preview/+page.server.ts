import type { ServerLoad } from "@sveltejs/kit";
import { getMailFeatureState } from "../../util/is-mail-enabled.ts";

export const load: ServerLoad = ({ locals }) => {
  const { appConfig } = locals.dependencies;
  const mailFeatureState = getMailFeatureState(appConfig);
  return {
    isMailEnabled: mailFeatureState.enabled,
    mailFeatureState,
  };
};
