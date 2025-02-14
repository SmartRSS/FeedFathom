import { type PageServerLoad } from "../$types";
import { isMailEnabled } from "../../util/is-mail-enabled";

export const load: PageServerLoad = () => {
  return {
    isMailEnabled,
  };
};
