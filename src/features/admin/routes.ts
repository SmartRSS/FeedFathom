import { Elysia } from "elysia";
import {
  adminQuery,
  passwordRequest,
  redirectDeletionRequest,
  removeSourceRequest,
  sourceUrlReplacementRequest,
} from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import type { RedirectMap } from "#platform/http/redirect-map.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { OpmlParser } from "#features/feeds/opml-parser.ts";
import type {
  SourcesDataService,
  SourceUrlUpdateResult,
} from "#features/feeds/source-data-service.ts";
import type { OpmlImportService } from "#features/feeds/opml-import-service.ts";
import {
  deleteAdminRedirectsHandler,
  getAdminRedirectsHandler,
} from "#features/admin/routes/admin-redirects.ts";
import {
  deleteAdminHandler,
  getAdminHandler,
  postAdminHandler,
} from "#features/admin/routes/admin.ts";
import {
  opmlRequest,
  postOptionsOpmlHandler,
} from "#features/admin/routes/options-opml.ts";
import { postOptionsPasswordHandler } from "#features/admin/routes/options-password.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type AdminOptionsRouteDependencies = {
  opmlImportService: Pick<OpmlImportService, "insertTree">;
  opmlParser: Pick<OpmlParser, "parseOpml">;
  password: Password;
  redirectMap: Pick<RedirectMap, "getAllRedirects" | "removeRedirect">;
  sourcesDataService: Pick<
    SourcesDataService,
    "deleteSource" | "listAllSources"
  > & {
    updateSourceUrl(
      oldUrl: string,
      newUrl: string,
    ): Promise<SourceUrlUpdateResult | void>;
  };
  // See the note on the same field in features/auth/routes.ts: picked where
  // the real signature is usable, widened only where the result is a
  // driver-specific execute() value nothing reads.
  usersDataService: Pick<
    UsersDataService,
    "findUser" | "getUserBySid" | "touchLastSeen"
  > & {
    updatePassword(userId: number, passwordHash: string): Promise<unknown>;
  };
};

export const createAdminOptionsRoutes = (deps: AdminOptionsRouteDependencies) =>
  new Elysia()
    .use(createAuthPlugin(deps.usersDataService))
    .get("/api/options", ({ user }) => json({ user }))
    .post("/api/options/password", { body: passwordRequest }, (ctx) =>
      postOptionsPasswordHandler(ctx, deps),
    )
    .post("/api/options/opml", { body: opmlRequest }, (ctx) =>
      postOptionsOpmlHandler(ctx, deps),
    )
    .get("/api/admin", { query: adminQuery }, (ctx) =>
      getAdminHandler(ctx, deps),
    )
    .post("/api/admin", { body: sourceUrlReplacementRequest }, (ctx) =>
      postAdminHandler(ctx, deps),
    )
    .delete("/api/admin", { body: removeSourceRequest }, (ctx) =>
      deleteAdminHandler(ctx, deps),
    )
    .get("/api/admin/redirects", (ctx) => getAdminRedirectsHandler(ctx, deps))
    .delete("/api/admin/redirects", { body: redirectDeletionRequest }, (ctx) =>
      deleteAdminRedirectsHandler(ctx, deps),
    );
