import {
  foldersDataService,
  userSourcesDataService,
} from "#features/feeds/services.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import { isSnoozed } from "#features/feeds/source-snooze-policy.ts";

export async function getTreeHandler({ user }: { user: AuthedUser }) {
  const [sources, folders] = await Promise.all([
    userSourcesDataService.getUserSources(user.id),
    foldersDataService.getUserFolders(user.id),
  ]);
  const children = new Map<number, unknown[]>();
  const roots: unknown[] = [];
  for (const source of sources) {
    // Snooze (#725) is display-level suppression: the stored unread count
    // keeps accumulating so the backlog survives, but while the pause is
    // active the tree shows none of it -- the same answer the unread article
    // list gives, evaluated lazily here so expiry needs no job.
    const snoozed = isSnoozed(source.pausedUntil ?? null);
    const item = {
      // No fingerprint means no favicon (#902): a bare id would still 404,
      // but on every load, so a missing icon gets no URL at all instead.
      favicon: source.faviconFingerprint
        ? `/api/favicon/${source.id}?v=${source.faviconFingerprint}`
        : null,
      homeUrl: source.homeUrl ?? "",
      kind: source.kind ?? "feed",
      name: source.name,
      pausedUntil: source.pausedUntil?.toJSON() ?? null,
      type: "source",
      uid: source.id?.toString() ?? "",
      unreadCount: snoozed ? 0 : source.unreadArticlesCount,
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
