import { createRequestHandler } from "$lib/create-request-handler";
import { type RequestEvent, type RequestHandler, json } from "@sveltejs/kit";
import { deleteFolderHandler } from "./handler.ts";
import { DeleteFolder } from "./validator.ts";

export const GET: RequestHandler = async ({ locals }: RequestEvent) => {
  try {
    if (!locals.user) {
      return json([]);
    }

    const folders = await locals.dependencies.foldersRepository.getUserFolders(
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
