import { Elysia } from "elysia";
import type { SourcesDataService } from "../../db/data-services/source-data-service.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin } from "../shared.ts";

export type FaviconRouteDependencies = {
  sourcesDataService: Pick<SourcesDataService, "getFavicon">;
  usersDataService: Pick<UsersDataService, "getUserBySid">;
};

export function createFaviconRoute({
  sourcesDataService,
  usersDataService,
}: FaviconRouteDependencies) {
  return new Elysia()
    .use(createAuthPlugin(usersDataService))
    .get("/api/favicon/:id", async ({ params, status }) => {
      const sourceId = Number(params.id);
      const dataUrl = Number.isInteger(sourceId)
        ? await sourcesDataService.getFavicon(sourceId)
        : null;
      const match = dataUrl
        ? /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
        : null;
      if (!match) return status(404);
      return new Response(Buffer.from(match[2] ?? "", "base64"), {
        headers: {
          "Cache-Control": "public, max-age=86400",
          "Content-Type": match[1] ?? "application/octet-stream",
        },
      });
    });
}
