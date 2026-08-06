import type { FoldersDataService } from "../../db/data-services/folder-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import { type AuthedUser, json } from "../shared.ts";

export type TreeRouteDependencies = {
  foldersDataService: Pick<FoldersDataService, "getUserFolders">;
  userSourcesDataService: Pick<UserSourcesDataService, "getUserSources">;
};

export async function getTreeHandler(
  { user }: { user: AuthedUser },
  { foldersDataService, userSourcesDataService }: TreeRouteDependencies,
) {
  // TEMPORARY: artificial delay so the tree skeleton is actually visible for
  // a visual QA pass. Remove once that's done -- not meant to ship.
  await new Promise((resolve) => setTimeout(resolve, 1000));
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
}
