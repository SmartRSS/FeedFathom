import { isMailEnabled } from "../../util/is-mail-enabled.ts";

export const load = () => {
  return {
    isMailEnabled,
  };
};
