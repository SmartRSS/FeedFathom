import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import type { DeleteFolder } from "./validator.ts";

export const deleteFolderHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteFolder>) => {
  await locals.dependencies.foldersDataService.removeUserFolder(
    locals.user.id,
    body.removeFolderId,
  );

  return json(body.removeFolderId);
};
