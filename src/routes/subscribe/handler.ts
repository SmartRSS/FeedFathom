import { type ValidatedRequestEvent } from "../../app";
import { isMailEnabled } from "../../util/is-mail-enabled";
import { type SubscribeRequest } from "./validator";
import { json } from "@sveltejs/kit";

export const subscribeHandler = async ({
  body,
  locals,
  url,
}: ValidatedRequestEvent<SubscribeRequest>) => {
  const { sourceFolder, sourceName, sourceUrl } = body;

  // Check if email is provided as sourceUrl while !isMailEnabled
  if (!isMailEnabled && sourceUrl.includes("@")) {
    return json(
      { error: "Email subscriptions are not allowed." },
      { status: 400 },
    );
  }

  if (sourceUrl.includes("@")) {
    await locals.dependencies.userSourcesRepository.addSourceToUser(
      locals.user.id,
      {
        homeUrl: url.origin,
        name: sourceName,
        parentId: sourceFolder,
        url: sourceUrl,
      },
    );
    return json(true);
  }

  try {
    const preview = await locals.dependencies.feedParser.preview(sourceUrl);
    if (!preview) {
      return json(false);
    }

    await locals.dependencies.userSourcesRepository.addSourceToUser(
      locals.user.id,
      {
        homeUrl: preview.link ?? url.origin,
        name: sourceName,
        parentId: sourceFolder,
        url: sourceUrl,
      },
    );
    return json(true);
  } catch {
    return json(false);
  }
};
