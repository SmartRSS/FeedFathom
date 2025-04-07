import feed from "$lib/images/feed.png";
import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return new Response(null, { status: 404 });
  }

  const sourceId = params["id"];
  if (!sourceId) {
    return new Response(null, { status: 404 });
  }

  const userSources =
    await locals.dependencies.userSourcesRepository.getUserSources(
      locals.user.id,
    );

  const source = userSources.find((s) => s.id?.toString() === sourceId);
  if (!source?.favicon) {
    return new Response(feed, {
      headers: {
        "Content-Type": "image/svg",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      },
    });
  }

  const base64Data = source.favicon.split(",")[1];
  if (!base64Data) {
    return new Response(feed, {
      headers: {
        "Content-Type": "image/svg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Convert base64 to binary
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
    },
  });
};
