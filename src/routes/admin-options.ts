import { Elysia } from "elysia";
import type {
  SourcesDataService,
  SourceUrlUpdateResult,
} from "../db/data-services/source-data-service.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import type { UserSourcesDataService } from "../db/data-services/user-source-data-service.ts";
import type { OpmlParser } from "../lib/opml-parser.ts";
import type { RedirectMap } from "../lib/redirect-map.ts";
import { createAdminRedirectsRoute } from "./admin-options/admin-redirects.ts";
import { createAdminRoute } from "./admin-options/admin.ts";
import { createOptionsOpmlRoute } from "./admin-options/options-opml.ts";
import { createOptionsPasswordRoute } from "./admin-options/options-password.ts";
import { createOptionsRoute } from "./admin-options/options.ts";

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

export const createAdminOptionsRoutes = (deps: AdminOptionsRouteDependencies) =>
  new Elysia()
    .use(createOptionsRoute(deps))
    .use(createOptionsPasswordRoute(deps))
    .use(createOptionsOpmlRoute(deps))
    .use(createAdminRoute(deps))
    .use(createAdminRedirectsRoute(deps));
