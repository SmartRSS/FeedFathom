import { json, type RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ locals, url }) => {
  const feedUrl = url.searchParams.get("feedUrl");
  if (!feedUrl) {
    return json({
      error: "No feed url",
    });
  }

  if (!URL.canParse(feedUrl)) {
    return json({
      error: "Invalid feed url",
    });
  }

  const source = await locals.dependencies.feedParser.preview(feedUrl);
  if (!source) {
    return json({
      error: "Invalid feed url",
    });
  }

  return json(source);
};
