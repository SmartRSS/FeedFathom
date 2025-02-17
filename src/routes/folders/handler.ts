import { type ValidatedRequestEvent } from "$lib/create-request-handler";
import { type DeleteFolder } from "./validator";
import { json } from "@sveltejs/kit";

export const deleteFolderHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteFolder>) => {
  await locals.dependencies.foldersRepository.removeUserFolder(
    locals.user.id,
    body.removeFolderId,
  );

  return json(body.removeFolderId);
};
