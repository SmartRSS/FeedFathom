import { faviconStore } from "#features/feeds/services.ts";

export async function getFaviconHandler({
  params,
  status,
}: {
  params: { id: string };
  status: (code: number) => unknown;
}) {
  const sourceId = Number(params.id);
  const dataUrl = Number.isInteger(sourceId)
    ? await faviconStore.getFavicon(sourceId)
    : null;
  // Parameters (`image/png; charset=x`) are dropped; anything but image/* is
  // refused so stored bytes never render as a document in the app origin.
  const match = dataUrl
    ? /^data:(image\/[^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl)
    : null;
  if (!match) return status(404);
  return new Response(Buffer.from(match[2] ?? "", "base64"), {
    headers: {
      // private, not public: this route sits behind the session cookie. The
      // URL's ?v= fingerprint (tree.ts) changes whenever the icon does, so a
      // response can be cached forever under its current URL.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Content-Type": match[1]?.trim() ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
