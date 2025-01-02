import { json, type RequestHandler } from "@sveltejs/kit";
import { JSDOM } from "jsdom";
import { scan } from "$lib/scanner";
import { err } from "../../util/log";

export const GET: RequestHandler = async ({ locals, url }) => {
  try {
    const link = url.searchParams.get("link");
    if (!link) {
      return json({
        error: "No feed url",
      });
    }
    const response = await locals.dependencies.axiosInstance.get(link);
    const doc = new JSDOM(response.data, { url: link });
    const possibleFeeds = await scan(link, doc.window.document);
    if (possibleFeeds.length === 0) {
      return json({
        error: "Invalid feed url",
      });
    }

    return json(possibleFeeds);
  } catch (e: unknown) {
    err(e);
    return json({
      error: "Invalid feed url",
    });
  }
};
