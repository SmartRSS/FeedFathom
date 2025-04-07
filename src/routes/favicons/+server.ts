import { type RequestHandler, json } from "@sveltejs/kit";
import { createHash } from "node:crypto";

const HASH_LENGTH = 8;

function getFaviconHash(favicon: string): string {
  return createHash("md5").update(favicon).digest("hex").slice(0, HASH_LENGTH);
}

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    return json({});
  }

  const sourceIds = url.searchParams.get("ids")?.split(",") ?? [];
  const clientHash = url.searchParams.get("hash") ?? "";

  if (sourceIds.length === 0) {
    return json({});
  }

  const userSources =
    await locals.dependencies.userSourcesRepository.getUserSources(
      locals.user.id,
    );

  const result: Record<
    string,
    { hash: string; data: string | null; changed: boolean }
  > = {};

  for (const source of userSources) {
    if (sourceIds.includes(source.id?.toString() ?? "")) {
      const sourceId = source.id?.toString() ?? "";
      const favicon = source.favicon;

      if (favicon) {
        const hash = getFaviconHash(favicon);
        result[sourceId] = {
          hash,
          data: hash !== clientHash ? favicon : null,
          changed: hash !== clientHash,
        };
      } else {
        result[sourceId] = {
          hash: "",
          data: null,
          changed: false,
        };
      }
    }
  }

  return json(result);
};
