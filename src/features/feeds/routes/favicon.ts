import type { FaviconStore } from "#features/feeds/favicon-store.ts";

export type FaviconRouteDependencies = {
  faviconStore: Pick<FaviconStore, "getFavicon">;
};

export async function getFaviconHandler(
  {
    params,
    status,
  }: { params: { id: string }; status: (code: number) => unknown },
  { faviconStore }: FaviconRouteDependencies,
) {
  const sourceId = Number(params.id);
  const dataUrl = Number.isInteger(sourceId)
    ? await faviconStore.getFavicon(sourceId)
    : null;
  const match = dataUrl ? /^data:([^;]+);base64,(.+)$/.exec(dataUrl) : null;
  if (!match) return status(404);
  return new Response(Buffer.from(match[2] ?? "", "base64"), {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": match[1] ?? "application/octet-stream",
    },
  });
}
