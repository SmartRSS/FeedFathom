import type * as feeds from "#features/feeds/services.ts";
import type { Static, StaticDecode } from "typebox";
import type {
  createFolderRequest,
  removeFolderRequest,
  updateFolderRequest,
} from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

type FolderServices = Pick<typeof feeds, "foldersDataService">;

export async function getFoldersHandler(
  { user }: { user: AuthedUser },
  { foldersDataService }: FolderServices,
) {
  return json(await foldersDataService.getUserFolders(user.id));
}

export async function postFoldersHandler(
  {
    body: decoded,
    user,
  }: {
    body: StaticDecode<typeof createFolderRequest>;
    user: AuthedUser;
  },
  { foldersDataService }: FolderServices,
) {
  return json(await foldersDataService.createFolder(user.id, decoded.name));
}

export async function patchFoldersHandler(
  {
    body: decoded,
    user,
  }: {
    body: StaticDecode<typeof updateFolderRequest>;
    user: AuthedUser;
  },
  { foldersDataService }: FolderServices,
) {
  const updated = await foldersDataService.renameFolder(
    user.id,
    decoded.folderId,
    decoded.folderName,
  );
  if (!updated) return json({ error: "Folder not found" }, 404);
  return json({ folderId: updated.id });
}

export async function deleteFoldersHandler(
  {
    body,
    user,
  }: {
    body: Static<typeof removeFolderRequest>;
    user: AuthedUser;
  },
  { foldersDataService }: FolderServices,
) {
  const result = await foldersDataService.removeEmptyUserFolder(
    user.id,
    body.removeFolderId,
  );
  if (result === "not-found") return json({ error: "Folder not found" }, 404);
  if (result === "not-empty")
    return json({ error: "Folder is not empty" }, 409);
  return json(body.removeFolderId);
}
