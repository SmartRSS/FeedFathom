import type * as mailIngest from "#features/mail-ingest/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import {
  mailRelaySecretHeader,
  maxRawEmailBytes,
} from "#shared/contracts/mail-relay.ts";
import { incomingMailRequest } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

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
    "/api/mail",
    { body: incomingMailRequest },
    async ({ body: decoded, request }) => {
      if (!config.MAIL_ENABLED) {
        return json({ error: "Mail ingestion is disabled" }, 404);
      }
      if (
        !matchesMailRelaySecret(
          config.MAIL_RELAY_SECRET,
          request.headers.get(mailRelaySecretHeader),
        )
      ) {
        return json({ error: "Unauthorized" }, 401);
      }

      // Base64, not UTF-8 text: a MIME message is bytes, and an 8-bit body in
      // a legacy charset does not survive a round trip through UTF-8.
      const raw = Buffer.from(decoded.raw, "base64");
      if (raw.byteLength > maxRawEmailBytes) {
        return json({ error: "Raw email exceeds 5 MiB" }, 413);
      }

      try {
        await emailHandler.processEmail(raw, {
          from: decoded.from,
          to: decoded.to,
        });
        return json({ ok: true });
      } catch (cause) {
        return json(
          { error: cause instanceof Error ? cause.message : "Unknown error" },
          500,
        );
      }
    },
  );
}
