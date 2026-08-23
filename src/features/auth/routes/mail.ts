import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { incomingMailRequest } from "#shared/contracts/requests.ts";
import type { AppConfig } from "#platform/config.ts";
import { json } from "#platform/http/json.ts";
import type { EmailHandler } from "../../../lib/email/email-handler.ts";

const mailRelaySecretHeader = "x-feedfathom-mail-secret";
const maxRawEmailBytes = 5 * 1_024 * 1_024;

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

export type MailRouteDependencies = {
  config: AppConfig;
  emailHandler: Pick<EmailHandler, "processEmail">;
};

export function createMailRoute({
  config,
  emailHandler,
}: MailRouteDependencies) {
  return new Elysia().post(
    "/api/mail",
    { body: incomingMailRequest },
    async ({ body, request }) => {
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

      const decoded = Value.Decode(incomingMailRequest, body);
      const raw = Buffer.from(decoded.raw, "utf8");
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
