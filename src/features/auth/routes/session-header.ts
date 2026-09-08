import { SESSION_TTL_DAYS } from "#platform/db/schemas/sessions.ts";

// The cookie and the session row it names must expire together: a server
// that would honour an expired sid defeats the point, and a cookie that
// outlives its session just buys a 401 on the next request.
export function sessionHeader(
  sid: string,
  secure: boolean,
  maxAge = SESSION_TTL_DAYS * 24 * 60 * 60,
) {
  return `sid=${sid}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}
