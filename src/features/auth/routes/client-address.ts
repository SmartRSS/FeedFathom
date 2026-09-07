/**
 * The caller's address, for keying anything counted per client.
 *
 * X-Forwarded-For is a chain the proxies append to, so the leftmost entry is
 * the one the first proxy saw. It is only as trustworthy as the proxy that
 * wrote it, which is what makes reading it opt-in: with nothing in front to
 * overwrite the header, its value is whatever the client typed.
 */
export function clientAddress(
  request: Request,
  server: { requestIP(request: Request): null | { address: string } } | null,
  trustedHeader: string | undefined,
): string {
  const forwarded = trustedHeader
    ? request.headers.get(trustedHeader)?.split(",")[0]?.trim()
    : undefined;
  if (forwarded) return forwarded;
  return server?.requestIP(request)?.address ?? "unknown";
}
