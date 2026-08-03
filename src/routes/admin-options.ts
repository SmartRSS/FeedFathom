import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Elysia, t } from "elysia";
import {
  adminQuery,
  passwordRequest,
  redirectDeletionRequest,
  sourceUrlReplacementRequest,
} from "../contracts/requests.ts";
import type {
  SourcesDataService,
  SourceUrlUpdateResult,
} from "../db/data-services/source-data-service.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import type { UserSourcesDataService } from "../db/data-services/user-source-data-service.ts";
import type { OpmlParser } from "../lib/opml-parser.ts";
import type { RedirectMap } from "../lib/redirect-map.ts";
import { plainTextPolicy } from "../lib/typebox-policy.ts";
import { json, userFor } from "./shared.ts";

const maximumOpmlBytes = 1024 * 1024;
const opmlRequest = Type.Object({ opml: t.File() });
type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type AdminOptionsRouteDependencies = {
  opmlParser: Pick<OpmlParser, "parseOpml">;
  password: Password;
  redirectMap: Pick<RedirectMap, "getAllRedirects" | "removeRedirect">;
  sourcesDataService: Pick<SourcesDataService, "listAllSources"> & {
    updateSourceUrl(
      oldUrl: string,
      newUrl: string,
    ): Promise<SourceUrlUpdateResult | void>;
  };
  usersDataService: {
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    getUserBySid(sid: string): ReturnType<UsersDataService["getUserBySid"]>;
    updatePassword(userId: number, passwordHash: string): Promise<unknown>;
  };
  userSourcesDataService: Pick<UserSourcesDataService, "insertTree">;
};

export const createAdminOptionsRoutes = ({
  opmlParser,
  password,
  redirectMap,
  sourcesDataService,
  usersDataService,
  userSourcesDataService,
}: AdminOptionsRouteDependencies) =>
  new Elysia()
    .derive(async ({ cookie, status }) => {
      const user = await userFor(cookie["sid"]?.value, usersDataService);
      return user ? { user } : status(401, { error: "Unauthorized" });
    })
    .get("/api/options", ({ user }) => json({ user }))
    .post(
      "/api/options/password",
      { body: passwordRequest },
      async ({ body, user }) => {
        const account = await usersDataService.findUser(user.email);
        if (
          !account ||
          !(await password.verify(body.oldPassword, account.password))
        )
          return json({ success: false }, 400);
        await usersDataService.updatePassword(
          account.id,
          await password.hash(body.password1),
        );
        return json({ success: true });
      },
    )
    .post(
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
    )
    .get("/api/admin", { query: adminQuery }, async ({ query, user }) => {
      if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
      return json(
        await sourcesDataService.listAllSources(
          query.sortBy ?? "createdAt",
          query.order ?? "asc",
        ),
      );
    })
    .post(
      "/api/admin",
      { body: sourceUrlReplacementRequest },
      async ({ body, user }) => {
        if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
        // Elysia 2.0-beta doesn't run Codec .Decode() transforms on bodies.
        const decoded = Value.Decode(sourceUrlReplacementRequest, body);
        const result = await sourcesDataService.updateSourceUrl(
          decoded.oldUrl,
          decoded.newUrl,
        );
        if (result === "conflict")
          return json({ error: "Source URL already exists" }, 409);
        if (result === "not-found")
          return json({ error: "Source URL not found" }, 404);
        return json({ success: true });
      },
    )
    .get("/api/admin/redirects", async ({ user }) =>
      user.isAdmin
        ? json(await redirectMap.getAllRedirects())
        : json({ error: "Unauthorized" }, 403),
    )
    .delete(
      "/api/admin/redirects",
      { body: redirectDeletionRequest },
      async ({ body, user }) => {
        if (!user.isAdmin) return json({ error: "Unauthorized" }, 403);
        const decoded = Value.Decode(redirectDeletionRequest, body);
        await redirectMap.removeRedirect(decoded.oldUrl);
        return json({ success: true });
      },
    );
