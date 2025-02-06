import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import { DeleteSource } from "./validator";

export const deleteSourceHandler = async ({
  locals,
  body,
}: ValidatedRequestEvent<DeleteSource>) => {
  await locals.dependencies.userSourcesRepository.removeSourceFromUser(
    locals.user.id,
    body.removeSourceId,
  );

  return json(body.removeSourceId);
};
