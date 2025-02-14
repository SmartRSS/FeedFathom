import { createRequestHandler } from "$lib/create-request-handler";
import { deleteFolderHandler } from "./handler";
import { DeleteFolder } from "./validator";
import { json, type RequestEvent, type RequestHandler } from "@sveltejs/kit";

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
