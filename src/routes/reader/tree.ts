import { Elysia } from "elysia";
import type { FoldersDataService } from "../../db/data-services/folder-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";

export type TreeRouteDependencies = {
  foldersDataService: Pick<FoldersDataService, "getUserFolders">;
  userSourcesDataService: Pick<UserSourcesDataService, "getUserSources">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createTreeRoute({
  foldersDataService,
  userSourcesDataService,
  usersDataService,
}: TreeRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .get("/api/tree", async ({ user }) => {
      const [sources, folders] = await Promise.all([
        userSourcesDataService.getUserSources(user.id),
        foldersDataService.getUserFolders(user.id),
      ]);
      const children = new Map<number, unknown[]>();
      const roots: unknown[] = [];
      for (const source of sources) {
        const item = {
          favicon: `/api/favicon/${source.id}`,
          homeUrl: source.homeUrl ?? "",
          name: source.name,
          type: "source",
          uid: source.id?.toString() ?? "",
          unreadCount: source.unreadArticlesCount,
          xmlUrl: source.url ?? "",
        };
        if (source.parentId)
          children.set(source.parentId, [
            ...(children.get(source.parentId) ?? []),
            item,
          ]);
        else roots.push(item);
      }
      return json({
        tree: [
          ...folders.map((folder) => ({
            children: children.get(folder.id) ?? [],
            name: folder.name,
            type: "folder",
            uid: folder.id.toString(),
          })),
          ...roots,
        ],
      });
    });
}
