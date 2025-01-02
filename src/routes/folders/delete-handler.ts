import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { DeleteFolderBody } from "./delete-validator";

export const deleteFolderHandler = async ({
  locals,
  request,
}: ValidatedRequestEvent<DeleteFolderBody>) => {
  await locals.dependencies.foldersRepository.removeUserFolder(
    locals.user.id,
    request.body.removeFolderId,
  );

  return json(request.body.removeFolderId);
};
