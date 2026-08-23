import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { websubVerificationQuery } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { verifyHubSignature } from "#features/feeds/websub.ts";

export type WebSubRouteDependencies = {
  sourcesDataService: Pick<
    SourcesDataService,
    "enqueueSource" | "findSourceByWebSubCallbackToken" | "markWebSubVerified"
  >;
};

// The hub SHOULD send hub.lease_seconds on every verification per spec, but
// "should" isn't "must" -- if it's missing, assume a short lease instead of
// an indefinite one, so a source without a real lease gets caught by the
// next day's renewal sweep instead of silently never renewing.
const defaultLeaseSeconds = 24 * 60 * 60;

export function createWebSubRoutes({
  sourcesDataService,
}: WebSubRouteDependencies) {
  return new Elysia()
    .get(
      "/api/websub/callback/:token",
      { query: websubVerificationQuery },
      async ({ params, query, status }) => {
        const source = await sourcesDataService.findSourceByWebSubCallbackToken(
          params.token,
        );
        // A hub MUST get a 404 for a subscription it can't verify -- that's
        // how it learns the request should be considered failed/deleted,
        // rather than retrying it forever.
        if (!source) return status(404);

        const decoded = Value.Decode(websubVerificationQuery, query);
        if (decoded["hub.mode"] !== "subscribe") return status(404);
        // Confirms the hub is verifying the exact topic we asked it to
        // subscribe us to, not some other feed it's conflating with this
        // callback token.
        if (decoded["hub.topic"] !== source.websubTopicUrl) return status(404);

        const requestedLease = Number(decoded["hub.lease_seconds"]);
        const leaseSeconds =
          Number.isFinite(requestedLease) && requestedLease > 0
            ? requestedLease
            : defaultLeaseSeconds;
        await sourcesDataService.markWebSubVerified(
          source.id,
          new Date(Date.now() + leaseSeconds * 1_000),
        );

        // Per spec: 2xx with the challenge echoed back verbatim as the
        // entire response body confirms the subscription.
        return new Response(decoded["hub.challenge"], {
          headers: { "Content-Type": "text/plain" },
        });
      },
    )
    .post(
      "/api/websub/callback/:token",
      async ({ params, request, status }) => {
        const source = await sourcesDataService.findSourceByWebSubCallbackToken(
          params.token,
        );
        if (!source?.websubSecret) return status(404);

        const body = Buffer.from(await request.arrayBuffer());
        const signature =
          request.headers.get("x-hub-signature-256") ??
          request.headers.get("x-hub-signature");
        if (!verifyHubSignature(source.websubSecret, signature, body))
          return status(403);

        // Don't trust the pushed body as article data -- it's an unverified
        // shape from the hub's perspective on the feed, not our own fetch.
        // The push is just a "something changed, go look" signal; re-fetching
        // through the normal pipeline reuses all the existing parsing,
        // caching, and dedup logic instead of a second "trust this POST body"
        // code path.
        await sourcesDataService.enqueueSource(
          { id: source.id, url: source.url },
          "websub-push",
        );
        return json({ ok: true });
      },
    );
}
