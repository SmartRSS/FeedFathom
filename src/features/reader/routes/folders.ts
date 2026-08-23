import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { removeFolderRequest } from "#shared/contracts/requests.ts";
import { createFolderRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";

export type FoldersRouteDependencies = {
  foldersDataService: Pick<
    FoldersDataService,
    "createFolder" | "getUserFolders" | "removeEmptyUserFolder"
  >;
};

export async function getFoldersHandler(
  { user }: { user: AuthedUser },
  { foldersDataService }: FoldersRouteDependencies,
) {
  return json(await foldersDataService.getUserFolders(user.id));
}

export async function postFoldersHandler(
  {
    body,
    user,
  }: { body: Static<typeof createFolderRequest>; user: AuthedUser },
  { foldersDataService }: FoldersRouteDependencies,
) {
  // Elysia 2.0-beta validates body shape but doesn't run Codec .Decode()
  // transforms, so normalized*() fields arrive undecoded; decode by hand.
  const decoded = Value.Decode(createFolderRequest, body);
  return json(await foldersDataService.createFolder(user.id, decoded.name));
}

export async function deleteFoldersHandler(
  {
    body,
    user,
  }: { body: Static<typeof removeFolderRequest>; user: AuthedUser },
  { foldersDataService }: FoldersRouteDependencies,
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
