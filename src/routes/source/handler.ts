import { type ValidatedRequestEvent } from "../../app";
import { type DeleteSource } from "./validator";
import { json } from "@sveltejs/kit";

export const deleteSourceHandler = async ({
  body,
  locals,
}: ValidatedRequestEvent<DeleteSource>) => {
  await locals.dependencies.userSourcesRepository.removeSourceFromUser(
    locals.user.id,
    body.removeSourceId,
  );

  return json(body.removeSourceId);
};
