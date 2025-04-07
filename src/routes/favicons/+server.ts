import { createHash } from "node:crypto";
import { type RequestHandler, json } from "@sveltejs/kit";

const hashLength = 8;

function getFaviconHash(favicon: string): string {
  return createHash("md5").update(favicon).digest("hex").slice(0, hashLength);
}

function processFavicon(favicon: string | null, clientHash: string) {
  if (!favicon) {
    return {
      hash: "",
      data: null,
      changed: false,
    };
  }

  const hash = getFaviconHash(favicon);
  return {
    hash,
    data: hash !== clientHash ? favicon : null,
    changed: hash !== clientHash,
  };
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
    const sourceId = source.id?.toString() ?? "";
    if (sourceIds.includes(sourceId)) {
      result[sourceId] = processFavicon(source.favicon, clientHash);
    }
  }

  return json(result);
};
