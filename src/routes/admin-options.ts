import { Elysia } from "elysia";
import {
  adminQuery,
  passwordRequest,
  redirectDeletionRequest,
  removeSourceRequest,
  sourceUrlReplacementRequest,
} from "#shared/contracts/requests.ts";
import type { RedirectMap } from "#platform/http/redirect-map.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import type {
  SourcesDataService,
  SourceUrlUpdateResult,
} from "../db/data-services/source-data-service.ts";
import type { OpmlImportService } from "../db/data-services/opml-import-service.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import type { OpmlParser } from "../lib/opml-parser.ts";
import {
  deleteAdminRedirectsHandler,
  getAdminRedirectsHandler,
} from "./admin-options/admin-redirects.ts";
import {
  deleteAdminHandler,
  getAdminHandler,
  postAdminHandler,
} from "./admin-options/admin.ts";
import {
  opmlRequest,
  postOptionsOpmlHandler,
} from "./admin-options/options-opml.ts";
import { postOptionsPasswordHandler } from "./admin-options/options-password.ts";
import { getOptionsHandler } from "./admin-options/options.ts";

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
  usersDataService: {
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    getUserBySid(sid: string): ReturnType<UsersDataService["getUserBySid"]>;
    touchLastSeen(
      userId: number,
    ): ReturnType<UsersDataService["touchLastSeen"]>;
    updatePassword(userId: number, passwordHash: string): Promise<unknown>;
  };
};

export const createAdminOptionsRoutes = (deps: AdminOptionsRouteDependencies) =>
  new Elysia()
    .use(createAuthPlugin(deps.usersDataService))
    .get("/api/options", (ctx) => getOptionsHandler(ctx))
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
