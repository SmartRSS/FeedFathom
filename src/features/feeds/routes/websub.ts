import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { websubVerificationQuery } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import type { HttpClient } from "#platform/http/http-client.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import { verifyHubSignature } from "#features/feeds/websub.ts";
import {
  leaseExpiresAt,
  resolveLeaseSeconds,
} from "#features/feeds/websub-lease-policy.ts";

export type WebSubRouteDependencies = {
  httpClient: Pick<HttpClient, "seedCache">;
  sourcesDataService: Pick<
    SourcesDataService,
    "enqueueSource" | "findSourceByWebSubCallbackToken" | "markWebSubVerified"
  >;
};

// How long the pushed body stays fresh in the cache. Long enough for the job
// it is queued alongside to pick it up under any normal backlog, and no
// longer: past that the parse falls back to a real fetch, which is the safe
// direction to fail in. It also matches successSource's own fallback poll
// spacing, so a push never pulls the next fetch earlier than a poll would.
const pushedBodyFreshMs = 5 * 60_000;

// The hub SHOULD send hub.lease_seconds on every verification per spec, but
// "should" isn't "must" -- if it's missing, assume a short lease instead of
// an indefinite one, so a source without a real lease gets caught by the
// next day's renewal sweep instead of silently never renewing.

export function createWebSubRoutes({
  httpClient,
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

        const leaseSeconds = resolveLeaseSeconds(decoded["hub.lease_seconds"]);
        await sourcesDataService.markWebSubVerified(
          source.id,
          leaseExpiresAt(leaseSeconds, Date.now()),
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

        // The push carries the feed document and the signature above proves
        // it came from the hub we handed this secret to, so there is nothing
        // left to fetch. Seeding the cache hands it to the ordinary parse
        // pipeline -- same parsing, dedup and article mapping, no second
        // "trust this POST body" path -- and leaves the stored entry holding
        // the new document rather than the one the push replaced.
        //
        // A thin ping carries no body. Nothing to seed, so the parse skips
        // the cache and fetches, which is what the push used to do always.
        let seeded = false;
        if (body.byteLength > 0) {
          try {
            await httpClient.seedCache(
              source.url,
              body,
              request.headers,
              pushedBodyFreshMs,
            );
            seeded = true;
          } catch (error) {
            // A push we could not store is still a push. Falling through to a
            // fetch loses the saved request, not the notification.
            console.error(`WebSub push seed failed for ${source.url}:`, error);
          }
        }
        await sourcesDataService.enqueueSource(
          { id: source.id, url: source.url },
          "websub-push",
          !seeded,
        );
        return json({ ok: true });
      },
    );
}
