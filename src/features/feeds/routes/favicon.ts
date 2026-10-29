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
  // Parameters (`image/png; charset=x`) are dropped and anything but image/* is
  // refused. The CSP sandbox below is what keeps an SVG opened directly from
  // running script in the app origin; the type filter alone does not.
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
      "Content-Type": match[1]?.trim() ?? "",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
