import { createHash } from "node:crypto";
import { t } from "elysia";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { plainTextPolicy } from "#shared/validation/typebox-policy.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import type { OpmlImportService } from "../../db/data-services/opml-import-service.ts";
import type { OpmlParser } from "../../lib/opml-parser.ts";
import { json } from "../shared.ts";

const maximumOpmlBytes = 1024 * 1024;
export const opmlRequest = Type.Object({ opml: t.File() });

export type OptionsOpmlRouteDependencies = {
  opmlImportService: Pick<OpmlImportService, "insertTree">;
  opmlParser: Pick<OpmlParser, "parseOpml">;
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
