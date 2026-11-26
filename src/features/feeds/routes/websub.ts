import type * as feeds from "#features/feeds/services.ts";
import { Elysia } from "elysia";
import { websubVerificationQuery } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import { maximumFeedBodyBytes } from "#platform/http/http-cache-store.ts";
import {
  verifyHubSignature,
  webSubCallbackPath,
} from "#features/feeds/websub.ts";
import { resolveLeaseSeconds } from "#features/feeds/websub-lease-policy.ts";

const readCappedPushBody = async (
  request: Request,
): Promise<Buffer | undefined> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumFeedBodyBytes)
    return undefined;

  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumFeedBodyBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

export type WebSubRouteServices = Pick<
  typeof feeds,
  "sourceJobs" | "websubStateService"
>;

export function createWebSubRoutes({
  sourceJobs,
  websubStateService,
}: WebSubRouteServices) {
  return new Elysia()
    .get(
      webSubCallbackPath(":token"),
      { query: websubVerificationQuery },
      async ({ params, query: decoded, status }) => {
        const source = await websubStateService.findSourceByWebSubCallbackToken(
          params.token,
        );
        if (!source) return status(404);

        if (decoded["hub.mode"] !== "subscribe") return status(404);
        if (decoded["hub.topic"] !== source.websubTopicUrl) return status(404);

        const leaseSeconds = resolveLeaseSeconds(decoded["hub.lease_seconds"]);
        await websubStateService.markWebSubVerified(
          source.id,
          new Date(Date.now() + leaseSeconds * 1_000),
        );

        return new Response(decoded["hub.challenge"], {
          headers: { "Content-Type": "text/plain" },
        });
      },
    )
    .post(webSubCallbackPath(":token"), async ({ params, request, status }) => {
      const source = await websubStateService.findSourceByWebSubCallbackToken(
        params.token,
      );
      if (!source?.websubSecret) return status(404);

      const body = await readCappedPushBody(request);
      if (!body) return status(413);
      const signature =
        request.headers.get("x-hub-signature-256") ??
        request.headers.get("x-hub-signature");
      if (!verifyHubSignature(source.websubSecret, signature, body))
        return status(403);

      await sourceJobs.push(source, body, request.headers);
      return json(successResponse, { success: true });
    });
}
