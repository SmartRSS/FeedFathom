import {
  foldersDataService,
  opmlImportService,
  opmlParser,
  userSourcesDataService,
} from "#features/feeds/services.ts";
import { createHash } from "node:crypto";
import { t } from "elysia";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { plainTextPolicy } from "#shared/validation/typebox-policy.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";
import type { OpmlNode, OpmlSource } from "#shared/types/opml-types.ts";
import { buildOpml } from "#features/feeds/opml-export.ts";
import type { OpmlParser } from "#features/feeds/opml-parser.ts";

const maximumOpmlBytes = 1024 * 1024;
export const opmlRequest = Type.Object({ opml: t.File() });

export async function postOptionsOpmlHandler({
  body,
  user,
}: {
  body: Static<typeof opmlRequest>;
  user: AuthedUser;
}) {
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
const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name);

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
  // Sorted here rather than trusted from the query. Re-importing an export is
  // a no-op only because opml_imports dedupes on a hash of the file's bytes --
  // insertTree creates a folder unconditionally, so a file that hashes
  // differently duplicates every folder in the tree. Two exports of an
  // unchanged tree therefore have to be byte-identical, which an ORDER BY
  // nobody has to remember is the way to get.
  return [
    ...folders.toSorted(byName).map((folder) => ({
      children: (foldered.get(folder.id) ?? []).toSorted(byName),
      name: folder.name,
      type: "folder" as const,
    })),
    ...roots.toSorted(byName),
  ];
}

export async function getOptionsOpmlHandler({ user }: { user: AuthedUser }) {
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
