import type { ValidatedRequestEvent } from "$lib/create-request-handler";
import { scan } from "$lib/scanner";
import { json } from "@sveltejs/kit";
import { JSDOM } from "jsdom";
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
    // First, try to get feed info using the feed parser
    const preview = await locals.dependencies.feedParser.preview(sourceUrl);
    if (!preview) {
      return json(false);
    }

    // Add the source to the user
    await locals.dependencies.userSourcesDataService.addSourceToUser(
      locals.user.id,
      {
        homeUrl: preview?.link ?? url.origin,
        name: sourceName,
        parentId: sourceFolder,
        url: sourceUrl,
      },
    );

    // Get the source ID by looking up the source by URL
    const source =
      await locals.dependencies.sourcesDataService.findSourceByUrl(sourceUrl);
    if (!source) {
      return json(false);
    }

    // Check if this source already has WebSub information
    const existingWebSubSubscription =
      await locals.dependencies.sourcesDataService.findWebSubSubscription(
        source.id,
      );

    // If no WebSub info exists, try to detect it using the scanner
    if (!existingWebSubSubscription) {
      try {
        // Fetch the feed content to scan for WebSub information
        const response = await locals.dependencies.axiosInstance.get(sourceUrl);
        const document = new JSDOM(response.data, { url: sourceUrl });
        const scannedFeeds = await scan(sourceUrl, document.window.document);

        // Find the feed that matches our URL
        const matchingFeed = scannedFeeds.find(
          (feed) => feed.url === sourceUrl,
        );

        if (matchingFeed?.webSub) {
          // Update the source with WebSub information
          await locals.dependencies.sourcesDataService.updateWebSubInfo(
            source.id,
            {
              hub: matchingFeed.webSub.hub,
              self: matchingFeed.webSub.self,
            },
          );

          // Subscribe to the WebSub hub
          try {
            await locals.dependencies.webSubService.subscribeToHub(
              matchingFeed.webSub,
              source.id,
              url.origin,
            );
          } catch (webSubError) {
            // Log the error but don't fail the subscription
            // The user can still subscribe to the feed even if WebSub fails
            console.error("WebSub subscription failed:", webSubError);
          }
        }
      } catch (scanError) {
        // Log the error but don't fail the subscription
        console.error("WebSub detection failed:", scanError);
      }
    }

    return json(true);
  } catch {
    return json(false);
  }
};
