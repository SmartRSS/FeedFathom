import { createHash } from "node:crypto";
import { Elysia, t } from "elysia";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import type { UserSourcesDataService } from "../../db/data-services/user-source-data-service.ts";
import type { OpmlParser } from "../../lib/opml-parser.ts";
import { plainTextPolicy } from "../../lib/typebox-policy.ts";
import { createAuthPlugin, json } from "../shared.ts";

const maximumOpmlBytes = 1024 * 1024;
const opmlRequest = Type.Object({ opml: t.File() });

export type OptionsOpmlRouteDependencies = {
  opmlParser: Pick<OpmlParser, "parseOpml">;
  userSourcesDataService: Pick<UserSourcesDataService, "insertTree">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createOptionsOpmlRoute({
  opmlParser,
  userSourcesDataService,
  usersDataService,
}: OptionsOpmlRouteDependencies) {
  return new Elysia().use(createAuthPlugin(usersDataService)).post(
    "/api/options/opml",
    { body: opmlRequest },
    async ({ body, user }) => {
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
      await userSourcesDataService.insertTree(user.id, tree, contentHash);
      return json({ success: true });
    },
  );
}
