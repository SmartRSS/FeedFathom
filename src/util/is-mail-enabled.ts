/**
 * Mail feature state logic:
 * - If MAIL_REPLICAS === '1': Only local mail worker is enabled, endpoint and remote features are disabled.
 * - If MAIL_REPLICAS === '0' and MAIL_ENABLED === true: Endpoint and all mail features are enabled (Cloudflare/remote mode).
 * - If MAIL_REPLICAS is not set or any other value: All mail features are disabled.
 */

import type { AppConfig } from "../config.ts";

export type MailFeatureState =
  | { mode: "local"; enabled: true }
  | { mode: "remote"; enabled: true }
  | { mode: "disabled"; enabled: false };

export function getMailFeatureState(appConfig: AppConfig): MailFeatureState {
  const replicas = process.env["MAIL_REPLICAS"];
  if (replicas === "1") {
    // Local mail worker only
    return { mode: "local", enabled: true };
  }
  if (replicas === "0" && appConfig.MAIL_ENABLED) {
    // Remote/Cloudflare mode
    return { mode: "remote", enabled: true };
  }
  // Disabled in all other cases
  return { mode: "disabled", enabled: false };
}
