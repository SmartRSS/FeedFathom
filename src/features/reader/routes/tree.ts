import type * as feeds from "#features/feeds/services.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { treeResponse } from "#shared/contracts/responses.ts";
import { groupByFolder } from "#features/feeds/folder-tree.ts";
import { isSnoozed } from "#shared/util/snooze.ts";

const failingAfter = 2;

export async function getTreeHandler(
  { user }: { user: AuthedUser },
  {
    foldersDataService,
    userSourcesDataService,
  }: Pick<typeof feeds, "foldersDataService" | "userSourcesDataService">,
) {
  const [sources, folders] = await Promise.all([
    userSourcesDataService.getUserSources(user.id),
    foldersDataService.getUserFolders(user.id),
  ]);
  const { children, roots } = groupByFolder(sources, (source) => {
    const snoozed = isSnoozed(source.pausedUntil);
    return {
      failing:
        source.recentFailures >= failingAfter
          ? {
              lastSuccess: source.lastSuccess?.toJSON() ?? null,
              reason: source.recentFailureDetails ?? "",
            }
          : null,
      favicon: source.faviconFingerprint
        ? `/api/favicon/${source.id}?v=${source.faviconFingerprint}`
        : null,
      homeUrl: source.homeUrl,
      kind: source.kind,
      name: source.name,
      pausedUntil: source.pausedUntil?.toJSON() ?? null,
      type: "source" as const,
      uid: source.id.toString(),
      unreadCount: snoozed ? 0 : source.unreadArticlesCount,
      xmlUrl: source.url,
    };
  });
  return json(treeResponse, {
    tree: [
      ...folders.map((folder) => ({
        children: children.get(folder.id) ?? [],
        name: folder.name,
        type: "folder" as const,
        uid: folder.id.toString(),
      })),
      ...roots,
    ],
  });
}
