import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { DeleteFolder } from "./validator";

export const deleteFolderHandler = async ({
  locals,
  request,
}: ValidatedRequestEvent<DeleteFolder>) => {
  await locals.dependencies.foldersRepository.removeUserFolder(
    locals.user.id,
    request.body.removeFolderId,
  );

  return json(request.body.removeFolderId);
};
