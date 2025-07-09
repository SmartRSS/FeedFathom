import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import { json } from "@sveltejs/kit";
import { getMailFeatureState } from "../../util/is-mail-enabled.ts";
import type { SubscribeRequest } from "./validator.ts";

export const subscribeHandler = async ({
  body,
  locals,
  url,
}: ValidatedRequestEvent<SubscribeRequest>) => {
  const { sourceFolder, sourceName, sourceUrl } = body;
  const { appConfig } = locals.dependencies;
  const mailFeatureState = getMailFeatureState(appConfig);

  // Check if email is provided as sourceUrl while mail is not enabled
  if (!mailFeatureState.enabled && sourceUrl.includes("@")) {
    return json(
      { error: "Email subscriptions are not allowed." },
      { status: 400 },
    );
  }

  if (sourceUrl.includes("@")) {
    await locals.dependencies.userSourcesDataService.addSourceToUser(
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

    await locals.dependencies.userSourcesDataService.addSourceToUser(
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
