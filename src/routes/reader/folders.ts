import { Elysia } from "elysia";
import { Value } from "typebox/value";
import {
  createFolderRequest,
  removeFolderRequest,
} from "../../contracts/requests.ts";
import type { FoldersDataService } from "../../db/data-services/folder-data-service.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type FoldersRouteDependencies = {
  foldersDataService: Pick<
    FoldersDataService,
    "createFolder" | "getUserFolders" | "removeEmptyUserFolder"
  >;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createFoldersRoutes({
  foldersDataService,
  usersDataService,
}: FoldersRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .get("/api/folders", async ({ user }) =>
      json(await foldersDataService.getUserFolders(user.id)),
    )
    .post(
      "/api/folders",
      { body: createFolderRequest },
      async ({ body, user }) => {
        // Elysia 2.0-beta validates body shape but doesn't run Codec .Decode()
        // transforms, so normalized*() fields arrive undecoded; decode by hand.
        const decoded = Value.Decode(createFolderRequest, body);
        return json(
          await foldersDataService.createFolder(user.id, decoded.name),
        );
      },
    )
    .delete(
      "/api/folders",
      { body: removeFolderRequest },
      async ({ body, user }) => {
        const result = await foldersDataService.removeEmptyUserFolder(
          user.id,
          body.removeFolderId,
        );
        if (result === "not-found")
          return json({ error: "Folder not found" }, 404);
        if (result === "not-empty")
          return json({ error: "Folder is not empty" }, 409);
        return json(body.removeFolderId);
      },
    );
}
