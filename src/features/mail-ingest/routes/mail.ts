import type * as mailIngest from "#features/mail-ingest/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import {
  type MailRelayRequest,
  mailRelayPath,
  mailRelaySecretHeader,
  maxRawEmailBytes,
  maxRawEmailMebibytes,
} from "#shared/contracts/mail-relay.ts";
import { incomingMailRequest } from "#shared/contracts/requests.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";

function matchesMailRelaySecret(
  expected: string | undefined,
  provided: string | null,
) {
  const expectedDigest = createHash("sha256")
    .update(expected ?? "")
    .digest();
  const providedDigest = createHash("sha256")
    .update(provided ?? "")
    .digest();
  const matches = timingSafeEqual(expectedDigest, providedDigest);
  return Boolean(expected && provided) && matches;
}

export type MailRouteServices = Pick<typeof mailIngest, "emailHandler"> & {
  config: AppConfig;
};

export function createMailRoute({ config, emailHandler }: MailRouteServices) {
  return new Elysia().post(
    mailRelayPath,
    { body: incomingMailRequest },
    async ({ body, request }) => {
      if (!config.MAIL_ENABLED) {
        return jsonError("Mail ingestion is disabled", 404);
      }
      if (
        !matchesMailRelaySecret(
          config.MAIL_RELAY_SECRET,
          request.headers.get(mailRelaySecretHeader),
        )
      ) {
        return jsonError("Unauthorized", 401);
      }

      const relayed: MailRelayRequest = body;
      const raw = Buffer.from(relayed.raw, "base64");
      if (raw.byteLength > maxRawEmailBytes) {
        return jsonError(`Raw email exceeds ${maxRawEmailMebibytes} MiB`, 413);
      }

      await emailHandler.processEmail(raw, {
        from: relayed.from,
        to: relayed.to,
      });
      return json(successResponse, { success: true });
    },
  );
}
