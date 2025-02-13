import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import type { UpdateSourceRequest } from "./update-source.validator";

export const updateSourceHandler = async (
  event: ValidatedRequestEvent<UpdateSourceRequest>,
) => {
  const { locals, body } = event;
  const user = locals.user; // Assuming user info is stored in locals
  if (!user.isAdmin) {
    return json({ error: "Unauthorized" }, { status: 403 });
  }

  const { oldUrl, newUrl } = body;

  // Call the repository method to update the source using oldUrl as the key
  await locals.dependencies.sourcesRepository.updateSourceUrl(oldUrl, newUrl);

  return json({ success: true });
};
