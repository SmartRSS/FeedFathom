import type * as feeds from "#features/feeds/services.ts";

export async function getFaviconHandler(
  {
    params,
    status,
  }: {
    params: { id: string };
    status: (code: number) => unknown;
  },
  { sourcesDataService }: Pick<typeof feeds, "sourcesDataService">,
) {
  const sourceId = Number(params.id);
  const dataUrl = Number.isInteger(sourceId)
    ? await sourcesDataService.getFavicon(sourceId)
    : null;
  const match = dataUrl
    ? /^data:(image\/[^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl)
    : null;
  if (!match) return status(404);
  return new Response(Buffer.from(match[2] ?? "", "base64"), {
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Content-Type": match[1]?.trim() ?? "",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
