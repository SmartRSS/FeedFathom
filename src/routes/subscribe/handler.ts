import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import type { FeedPreview } from "$lib/feed-mapper";
import { json } from "@sveltejs/kit";
import { isMailEnabled } from "../../util/is-mail-enabled.ts";
import type { SubscribeRequest } from "./validator.ts";

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
    const preview = (await locals.dependencies.feedParser.preview(
      sourceUrl,
    )) as FeedPreview;
    if (!preview) {
      return json(false);
    }

    await locals.dependencies.userSourcesRepository.addSourceToUser(
      locals.user.id,
      {
        homeUrl: preview?.link ?? url.origin,
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
