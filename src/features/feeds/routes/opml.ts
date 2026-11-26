import type * as feeds from "#features/feeds/services.ts";
import { t } from "elysia";
import { type Static, Type } from "typebox";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { opmlUploadField } from "#shared/contracts/requests.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import type { OpmlNode, OpmlSource } from "#features/feeds/opml-types.ts";
import { buildOpml } from "#features/feeds/opml-export.ts";
import { groupByFolder } from "#features/feeds/folder-tree.ts";

const maximumOpmlBytes = 1024 * 1024;
export const opmlRequest = Type.Object({ [opmlUploadField]: t.File() });

export async function postOpmlHandler(
  {
    body,
    user,
  }: {
    body: Static<typeof opmlRequest>;
    user: AuthedUser;
  },
  {
    feedRequests,
    opmlImportService,
  }: Pick<typeof feeds, "feedRequests" | "opmlImportService">,
) {
  if (body.opml.size > maximumOpmlBytes)
    return jsonError("File is too large", 413);

  const reply = await feedRequests.parseOpml(
    new Uint8Array(await body.opml.arrayBuffer()),
  );
  if ("invalid" in reply)
    return jsonError(
      reply.invalid === "file" ? "Invalid file" : "Invalid OPML",
      400,
    );
  await opmlImportService.insertTree(user.id, reply.tree, reply.contentHash);
  return json(successResponse, { success: true });
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name);

function subscriptionTree(
  folders: { id: number; name: string }[],
  sources: {
    kind: string;
    name: string;
    homeUrl: string;
    parentId: null | number;
    url: string;
  }[],
): OpmlNode[] {
  const { children, roots } = groupByFolder(
    sources.filter((source) => source.kind !== "email"),
    (source): OpmlSource => ({
      homeUrl: source.homeUrl,
      name: source.name,
      type: "source",
      xmlUrl: source.url,
    }),
  );
  return [
    ...folders.toSorted(byName).map((folder) => ({
      children: (children.get(folder.id) ?? []).toSorted(byName),
      name: folder.name,
      type: "folder" as const,
    })),
    ...roots.toSorted(byName),
  ];
}

export async function getOpmlHandler(
  { user }: { user: AuthedUser },
  {
    foldersDataService,
    userSourcesDataService,
  }: Pick<typeof feeds, "foldersDataService" | "userSourcesDataService">,
) {
  const [folders, sources] = await Promise.all([
    foldersDataService.getUserFolders(user.id),
    userSourcesDataService.getUserSources(user.id),
  ]);
  return new Response(
    buildOpml("FeedFathom subscriptions", subscriptionTree(folders, sources)),
    {
      headers: {
        "content-disposition":
          'attachment; filename="feedfathom-subscriptions.opml"',
        "content-type": "text/x-opml; charset=utf-8",
      },
    },
  );
}
