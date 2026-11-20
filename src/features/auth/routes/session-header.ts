import { SESSION_TTL_DAYS } from "#platform/db/schemas/sessions.ts";

export const sessionCookie = "sid";

export function sessionHeader(
  sid: string,
  secure: boolean,
  maxAge = SESSION_TTL_DAYS * 24 * 60 * 60,
) {
  return `${sessionCookie}=${sid}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}
