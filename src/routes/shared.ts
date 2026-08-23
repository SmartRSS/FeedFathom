export function json(value: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(value, headers ? { headers, status } : { status });
}
