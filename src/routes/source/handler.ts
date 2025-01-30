import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import { DeleteSource } from "./validator";

export const deleteSourceHandler = async ({
  locals,
  request,
}: ValidatedRequestEvent<DeleteSource>) => {
  if (!locals.user) {
    return json([]);
  }
  await locals.dependencies.userSourcesRepository.removeSourceFromUser(
    locals.user.id,
    request.body.removeSourceId,
  );

  return json(request.body.removeSourceId);
};
