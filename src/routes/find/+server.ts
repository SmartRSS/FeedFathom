import { scan } from "$lib/scanner";
import { json, type RequestHandler } from "@sveltejs/kit";
import { JSDOM } from "jsdom";
import { logError as error_ } from "../../util/log.ts";

export const GET: RequestHandler = async ({ locals, url }) => {
  try {
    const link = url.searchParams.get("link");
    if (!link) {
      return json({
        error: "No feed url",
      });
    }

    const response = await locals.dependencies.axiosInstance.get(link);
    const document_ = new JSDOM(response.data, { url: link });
    const possibleFeeds = await scan(link, document_.window.document);
    if (possibleFeeds.length === 0) {
      return json({
        error: "Invalid feed url",
      });
    }

    return json(possibleFeeds);
  } catch (error: unknown) {
    error_(error);
    return json({
      error: "Invalid feed url",
    });
  }
};
