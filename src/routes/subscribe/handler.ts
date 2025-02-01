import { json } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../../app";
import { SubscribeRequest } from "./validator";

export const subscribeHandler = async ({
  body,
  locals,
  url,
}: ValidatedRequestEvent<SubscribeRequest>) => {
  const { sourceUrl, sourceName, sourceFolder } = body;
  const preview = sourceUrl.includes("@")
    ? null
    : await locals.dependencies.feedParser.preview(sourceUrl);
  if (!preview && !sourceUrl.includes("@")) {
    return json(false);
  }
  await locals.dependencies.userSourcesRepository.addSourceToUser(
    locals.user.id,
    {
      url: sourceUrl,
      homeUrl: preview?.link ?? url.origin,
      parentId: sourceFolder,
      name: sourceName,
    },
  );
  return json(true);
};
