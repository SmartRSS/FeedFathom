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
