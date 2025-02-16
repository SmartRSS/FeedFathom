import { type ValidatedRequestEvent } from "../../app";
import { type UpdateSourceRequest } from "./validator";
import { json } from "@sveltejs/kit";

export const updateSourceHandler = async (
  event: ValidatedRequestEvent<UpdateSourceRequest>,
) => {
  const { body, locals } = event;
  const user = locals.user;
  if (!user.isAdmin) {
    return json({ error: "Unauthorized" }, { status: 403 });
  }

  const { newUrl, oldUrl } = body;

  // Call the repository method to update the source using oldUrl as the key
  await locals.dependencies.sourcesRepository.updateSourceUrl(oldUrl, newUrl);

  return json({ success: true });
};
