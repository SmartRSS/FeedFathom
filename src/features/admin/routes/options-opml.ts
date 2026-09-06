import { createHash } from "node:crypto";
import { t } from "elysia";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { plainTextPolicy } from "#shared/validation/typebox-policy.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { OpmlNode, OpmlSource } from "#shared/types/opml-types.ts";
import type { FoldersDataService } from "#features/feeds/folder-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import { buildOpml } from "#features/feeds/opml-export.ts";
import type { OpmlParser } from "#features/feeds/opml-parser.ts";
import type { OpmlImportService } from "#features/feeds/opml-import-service.ts";

const maximumOpmlBytes = 1024 * 1024;
export const opmlRequest = Type.Object({ opml: t.File() });

export type OptionsOpmlRouteDependencies = {
  foldersDataService: Pick<FoldersDataService, "getUserFolders">;
  opmlImportService: Pick<OpmlImportService, "insertTree">;
  opmlParser: Pick<OpmlParser, "parseOpml">;
  userSourcesDataService: Pick<UserSourcesDataService, "getUserSources">;
};

export async function postOptionsOpmlHandler(
  { body, user }: { body: Static<typeof opmlRequest>; user: AuthedUser },
  { opmlImportService, opmlParser }: OptionsOpmlRouteDependencies,
) {
  if (body.opml.size > maximumOpmlBytes)
    return json({ error: "File is too large", success: false }, 413);

  const bytes = new Uint8Array(await body.opml.arrayBuffer());
  let content: string;
  let tree: ReturnType<OpmlParser["parseOpml"]>;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Value.Check(plainTextPolicy, content))
      return json({ error: "Invalid file", success: false }, 400);
    tree = opmlParser.parseOpml(content);
  } catch {
    return json({ error: "Invalid OPML", success: false }, 400);
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  await opmlImportService.insertTree(user.id, tree, contentHash);
  return json({ success: true });
}

// Newsletter subscriptions are left out. Their "url" is an address this
// instance minted and routes mail for, so an outline carrying it would be a
// feed no reader can fetch and, re-imported anywhere else, a subscription
// nothing would ever deliver to. Everything OPML can actually represent is a
// source with an http(s) URL.
function subscriptionTree(
  folders: { id: number; name: string }[],
  sources: {
    kind: null | string;
    name: string;
    homeUrl: null | string;
    parentId: null | number;
    url: null | string;
  }[],
): OpmlNode[] {
  const foldered = new Map<number, OpmlSource[]>();
  const roots: OpmlNode[] = [];
  for (const source of sources) {
    if (source.kind === "email" || !source.url?.startsWith("http")) continue;
    const outline: OpmlSource = {
      homeUrl: source.homeUrl ?? "",
      name: source.name,
      type: "source",
      xmlUrl: source.url,
    };
    if (source.parentId === null) roots.push(outline);
    else {
      const siblings = foldered.get(source.parentId) ?? [];
      siblings.push(outline);
      foldered.set(source.parentId, siblings);
    }
  }
  return [
    ...folders.map((folder) => ({
      children: foldered.get(folder.id) ?? [],
      name: folder.name,
      type: "folder" as const,
    })),
    ...roots,
  ];
}

export async function getOptionsOpmlHandler(
  { user }: { user: AuthedUser },
  { foldersDataService, userSourcesDataService }: OptionsOpmlRouteDependencies,
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
