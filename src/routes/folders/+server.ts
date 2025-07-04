import { createRequestHandler } from "$lib/create-request-handler";
import { json, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import { deleteFolderHandler } from "./handler.ts";
import { DeleteFolder } from "./validator.ts";

export const GET: RequestHandler = async ({ locals }: RequestEvent) => {
  try {
    if (!locals.user) {
      return json([]);
    }

    const folders = await locals.dependencies.foldersDataService.getUserFolders(
      locals.user.id,
    );
    return json(folders);
  } catch {
    return json({
      error: "Invalid feed url",
    });
  }
};

export const DELETE: RequestHandler = createRequestHandler(
  DeleteFolder,
  deleteFolderHandler,
);
