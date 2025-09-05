import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import type { DeleteSource } from "./validator.ts";

export const deleteSourceHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteSource>) => {
  await locals.dependencies.userSourcesDataService.removeSourceFromUser(
    locals.user.id,
    body.removeSourceId,
  );

  return json(body.removeSourceId);
};
