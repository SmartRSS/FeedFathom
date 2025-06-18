import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import { json } from "@sveltejs/kit";
import type { DeleteFolder } from "./validator.ts";

export const deleteFolderHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteFolder>) => {
  await locals.dependencies.foldersRepository.removeUserFolder(
    body.removeFolderId,
  );

  return json(body.removeFolderId);
};
