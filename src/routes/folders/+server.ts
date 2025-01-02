import { json, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import { createRequestHandler } from "$lib/create-request-handler";
import { deleteFolderValidator } from "./delete-validator";
import { deleteFolderHandler } from "./delete-handler";

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
  deleteFolderValidator,
  deleteFolderHandler,
);
