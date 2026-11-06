import type * as feeds from "#features/feeds/services.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { treeResponse } from "#shared/contracts/responses.ts";
import { groupByFolder } from "#features/feeds/folder-tree.ts";
import { isSnoozed } from "#features/feeds/source-snooze-policy.ts";

// One failed fetch is usually a blip the next poll recovers from; two in a
// row, with the backoff between them, is worth telling the reader about.
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
    // Snooze (#725) is display-level suppression: the stored unread count
    // keeps accumulating so the backlog survives, but while the pause is
    // active the tree shows none of it -- the same answer the unread article
    // list gives, evaluated lazily here so expiry needs no job.
    const snoozed = isSnoozed(source.pausedUntil);
    return {
      failing:
        source.recentFailures >= failingAfter
          ? {
              lastSuccess: source.lastSuccess?.toJSON() ?? null,
              reason: source.recentFailureDetails ?? "",
            }
          : null,
      // No fingerprint means no favicon (#902): a bare id would still 404,
      // but on every load, so a missing icon gets no URL at all instead.
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
