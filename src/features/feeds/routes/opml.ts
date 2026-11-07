import type * as feeds from "#features/feeds/services.ts";
import { createHash } from "node:crypto";
import { t } from "elysia";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { plainTextPolicy } from "#shared/validation/typebox-policy.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { opmlUploadField } from "#shared/contracts/requests.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import type { OpmlNode, OpmlSource } from "#features/feeds/opml-types.ts";
import { buildOpml } from "#features/feeds/opml-export.ts";
import { groupByFolder } from "#features/feeds/folder-tree.ts";
import { parseOpml } from "#features/feeds/opml-parser.ts";

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
  { opmlImportService }: Pick<typeof feeds, "opmlImportService">,
) {
  if (body.opml.size > maximumOpmlBytes)
    return jsonError("File is too large", 413);

  const bytes = new Uint8Array(await body.opml.arrayBuffer());
  let content: string;
  let tree: OpmlNode[];
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Value.Check(plainTextPolicy, content))
      return jsonError("Invalid file", 400);
    tree = parseOpml(content);
  } catch {
    return jsonError("Invalid OPML", 400);
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  await opmlImportService.insertTree(user.id, tree, contentHash);
  return json(successResponse, { success: true });
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name);

// Newsletter subscriptions are left out. Their "url" is an address this
// instance minted and routes mail for, so an outline carrying it would be a
// feed no reader can fetch and, re-imported anywhere else, a subscription
// nothing would ever deliver to.
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
  // Stable ordering keeps exports comparable even if query order changes.
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
