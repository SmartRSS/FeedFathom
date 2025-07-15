import type { RequestHandler } from "@sveltejs/kit";
import container from "../../../../../container.ts";
import type { SourcesDataService } from "../../../../../db/data-services/source-data-service.ts";
import { logError } from "../../../../../util/log.ts";

export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const sourceId = Number.parseInt(params["sourceId"] || "", 10);
    if (Number.isNaN(sourceId)) {
      return new Response("Invalid source ID", { status: 400 });
    }

    const sourcesDataService = container.cradle
      .sourcesDataService as SourcesDataService;
    const source = await sourcesDataService.findSourceById(sourceId);

    if (!source) {
      return new Response("Source not found", { status: 404 });
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const topic = url.searchParams.get("hub.topic");
    const challenge = url.searchParams.get("hub.challenge");
    const leaseSeconds = url.searchParams.get("hub.lease_seconds");

    // Handle subscription verification
    if (mode === "subscribe" && challenge) {
      try {
        const webSubService = container.cradle.webSubService;
        const verifiedChallenge = await webSubService.verifySubscription(
          sourceId,
          mode,
          topic || source.url,
          challenge,
          leaseSeconds ? Number.parseInt(leaseSeconds, 10) : undefined,
        );

        return new Response(verifiedChallenge, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
          },
        });
      } catch (error) {
        logError("WebSub verification failed:", error);
        return new Response("Verification failed", { status: 400 });
      }
    }

    // Handle content updates
    if (mode === "publish") {
      const contentType = request.headers.get("content-type");
      const content = await request.text();

      try {
        const webSubService = container.cradle.webSubService;
        await webSubService.handleContentNotification(
          sourceId,
          contentType || "",
          content,
        );

        return new Response("OK", { status: 200 });
      } catch (error) {
        logError("WebSub content notification failed:", error);
        return new Response("Content processing failed", { status: 400 });
      }
    }

    return new Response("Invalid mode", { status: 400 });
  } catch (error) {
    logError("WebSub callback error:", error);
    return new Response("Internal server error", { status: 500 });
  }
};

export const GET: RequestHandler = async ({ params, url }) => {
  try {
    const sourceId = Number.parseInt(params["sourceId"] || "", 10);
    if (Number.isNaN(sourceId)) {
      return new Response("Invalid source ID", { status: 400 });
    }

    const sourcesDataService = container.cradle
      .sourcesDataService as SourcesDataService;
    const source = await sourcesDataService.findSourceById(sourceId);

    if (!source) {
      return new Response("Source not found", { status: 404 });
    }

    const mode = url.searchParams.get("hub.mode");
    const topic = url.searchParams.get("hub.topic");
    const challenge = url.searchParams.get("hub.challenge");
    const leaseSeconds = url.searchParams.get("hub.lease_seconds");

    // Handle subscription verification
    if (mode === "subscribe" && challenge) {
      try {
        const webSubService = container.cradle.webSubService;
        const verifiedChallenge = await webSubService.verifySubscription(
          sourceId,
          mode,
          topic || source.url,
          challenge,
          leaseSeconds ? Number.parseInt(leaseSeconds, 10) : undefined,
        );

        return new Response(verifiedChallenge, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
          },
        });
      } catch (error) {
        logError("WebSub verification failed:", error);
        return new Response("Verification failed", { status: 400 });
      }
    }

    return new Response("Invalid request", { status: 400 });
  } catch (error) {
    logError("WebSub callback error:", error);
    return new Response("Internal server error", { status: 500 });
  }
};
