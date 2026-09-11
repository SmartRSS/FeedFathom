import { userSourcesDataService } from "#features/feeds/services.ts";
import type { Static } from "typebox";
import type {
  removeSourceRequest,
  snoozeSourceRequest,
  updateSourceRequest,
} from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

export async function deleteSourceHandler({
  body,
  user,
}: {
  body: Static<typeof removeSourceRequest>;
  user: AuthedUser;
}) {
  await userSourcesDataService.removeSourceFromUser(
    user.id,
    body.removeSourceId,
  );
  return json(body.removeSourceId);
}

export async function patchSourceHandler({
  body,
  user,
}: {
  body: Static<typeof updateSourceRequest>;
  user: AuthedUser;
}) {
  const updated = await userSourcesDataService.updateUserSource(
    user.id,
    body.sourceId,
    { name: body.sourceName, parentId: body.sourceFolder },
  );
  if (!updated) return json({ error: "Invalid folder or source" }, 400);
  return json({ sourceId: updated.id });
}

/**
 * Sets (or clears, with null) one subscription's snooze (#725). The write
 * touches only the timestamp -- article state and unread counts are left
 * alone, and suppression is evaluated lazily wherever unread is read.
 */
export async function snoozeSourceHandler({
  body,
  user,
}: {
  body: Static<typeof snoozeSourceRequest>;
  user: AuthedUser;
}) {
  const updated = await userSourcesDataService.setSourceSnooze(
    user.id,
    body.sourceId,
    body.pausedUntil === null ? null : new Date(body.pausedUntil),
  );
  if (!updated) return json({ error: "Invalid source" }, 400);
  return json({
    pausedUntil: updated.pausedUntil?.toJSON() ?? null,
    sourceId: updated.id,
  });
}
