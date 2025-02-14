import { err as error_ } from "../../util/log";
import { json, type RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ locals, url }) => {
  try {
    const feedUrl = url.searchParams.get("feedUrl");
    if (!feedUrl) {
      return json({
        error: "No feed url",
      });
    }

    new URL(feedUrl);
    const source = await locals.dependencies.feedParser.preview(feedUrl);
    if (!source) {
      return json({
        error: "Invalid feed url",
      });
    }

    return json(source);
  } catch (error) {
    error_(error);
    return json({
      error: "Invalid feed url",
    });
  }
};
