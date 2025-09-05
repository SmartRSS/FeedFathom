import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import type { UpdateSourceRequest } from "./validator.ts";

export const updateSourceHandler = async (
  event: ValidatedRequestEvent<UpdateSourceRequest>,
) => {
  const { body, locals } = event;
  const user = locals.user;
  if (!user.isAdmin) {
    return json({ error: "Unauthorized" }, { status: 403 });
  }

  const { newUrl, oldUrl } = body;

  // Call the DataService method to update the source using oldUrl as the key
  await locals.dependencies.sourcesDataService.updateSourceUrl(oldUrl, newUrl);

  return json({ success: true });
};
