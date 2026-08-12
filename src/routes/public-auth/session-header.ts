export function sessionHeader(
  sid: string,
  secure: boolean,
  maxAge = 365 * 24 * 60 * 60,
) {
  return `sid=${sid}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}
