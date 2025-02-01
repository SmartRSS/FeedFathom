import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { DeleteFolder } from "./validator";

export const deleteFolderHandler = async ({
  locals,
  body,
}: ValidatedRequestEvent<DeleteFolder>) => {
  await locals.dependencies.foldersRepository.removeUserFolder(
    locals.user.id,
    body.removeFolderId,
  );

  return json(body.removeFolderId);
};
