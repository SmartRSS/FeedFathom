import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import { json } from "@sveltejs/kit";
import type { DeleteSource } from "./validator.ts";

export const deleteSourceHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteSource>) => {
  const { userSourcesRepository, sourcesRepository, cloudflareKv } =
    locals.dependencies;
  const sourceId = body.removeSourceId;

  const source = await sourcesRepository.findSourceById(sourceId);

  if (source?.url.includes("@")) {
    await cloudflareKv.delete("feed_fathom", source.url);
  }

  await userSourcesRepository.removeSourceFromUser(locals.user.id, sourceId);

  return json(sourceId);
};
