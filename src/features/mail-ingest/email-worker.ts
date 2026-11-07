import {
  type MailRelayRequest,
  mailRelayPath,
  mailRelayRejectionStatus,
  mailRelaySecretHeader,
  maxRawEmailBytes,
  maxRawEmailMebibytes,
} from "#shared/contracts/mail-relay.ts";
import { readResponseDiagnostic } from "#platform/http/read-response-diagnostic.ts";
import { secureOrigin } from "#shared/util/safe-url.ts";

// Deliberately hand-written rather than expressed as schemas: this module is
// bundled for Cloudflare, and pulling typebox in for three checks over strings
// and one integer put 372 KB of runtime type registry -- 98.7% of the bundle --
// on the cold start path. The wire contract with /api/mail is mail-relay.ts,
// which is plain TypeScript for that reason.
type ErrorLogger = {
  error(message: string): void;
};

type WorkerEnvironment = {
  MAIL_ENDPOINT_DOMAIN: string;
  MAIL_RELAY_SECRET: string;
};

type MailEnvelope = {
  from: string;
  rawSize: number;
  to: string;
};

export type IncomingEmailMessage = {
  from: unknown;
  raw: BodyInit | null;
  rawSize: unknown;
  // Cloudflare's ForwardableEmailMessage: a permanent SMTP error, so the
  // sending server bounces the message and may suppress the address.
  setReject(reason: string): void;
  to: unknown;
};

const oversizeReason = `Message exceeds ${maxRawEmailMebibytes} MiB`;

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isWorkerEnvironment(value: unknown): value is WorkerEnvironment {
  return (
    typeof value === "object" &&
    value !== null &&
    "MAIL_ENDPOINT_DOMAIN" in value &&
    isNonblankString(value.MAIL_ENDPOINT_DOMAIN) &&
    "MAIL_RELAY_SECRET" in value &&
    isNonblankString(value.MAIL_RELAY_SECRET)
  );
}

// A bounce can make a newsletter platform drop the subscription, so the
// worker rejects only on a MailRelayRejection. Anything else -- a proxy's
// HTML 413, a schema 422 from version skew during a deploy -- is thrown: a
// temporary failure the sending server may retry.
function rejectionReason(diagnostic: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(diagnostic);
  } catch {
    return undefined;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("rejected" in body) ||
    body.rejected !== true
  ) {
    return undefined;
  }
  return "error" in body && isNonblankString(body.error)
    ? body.error.slice(0, 200)
    : "Message rejected";
}

function mailEnvelope(message: IncomingEmailMessage): MailEnvelope {
  const { from, rawSize, to } = message;
  if (
    !isNonblankString(from) ||
    !isNonblankString(to) ||
    typeof rawSize !== "number" ||
    !Number.isInteger(rawSize) ||
    rawSize < 0
  ) {
    throw new Error("Invalid incoming email message");
  }
  return { from, rawSize, to };
}

// btoa takes a binary string, and spreading 5 MiB into one call overflows the
// argument list, so the message is fed through in chunks.
function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x80_00;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

// Plaintext is allowed only where it cannot leave the host, because the
// relay secret and the whole message travel in this request.
function mailEndpoint(domain: string): URL {
  const origin = secureOrigin(domain);
  if (!origin)
    throw new Error(
      "MAIL_ENDPOINT_DOMAIN must be an https origin, or an http origin on loopback",
    );
  return new URL(mailRelayPath, origin);
}

export function createEmailWorker(
  fetcher: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch> = globalThis.fetch,
  logger: ErrorLogger = console,
) {
  return {
    async email(message: IncomingEmailMessage, env: unknown): Promise<void> {
      try {
        if (!isWorkerEnvironment(env)) {
          throw new Error("Invalid Cloudflare email worker environment");
        }
        const endpoint = mailEndpoint(env.MAIL_ENDPOINT_DOMAIN);
        const envelope = mailEnvelope(message);
        // The one rejection the worker decides alone: the size is the
        // sender's, and /api/mail would refuse it too.
        if (envelope.rawSize > maxRawEmailBytes) {
          message.setReject(oversizeReason);
          return;
        }

        const bytes = new Uint8Array(
          await new Response(message.raw).arrayBuffer(),
        );
        if (bytes.byteLength > maxRawEmailBytes) {
          message.setReject(oversizeReason);
          return;
        }

        const relayed: MailRelayRequest = {
          from: envelope.from,
          raw: toBase64(bytes),
          to: envelope.to,
        };
        const response = await fetcher(endpoint, {
          body: JSON.stringify(relayed),
          headers: {
            "content-type": "application/json",
            [mailRelaySecretHeader]: env.MAIL_RELAY_SECRET,
          },
          method: "POST",
        });
        if (!response.ok) {
          const diagnostic = await readResponseDiagnostic(response);
          const reason =
            response.status === mailRelayRejectionStatus
              ? rejectionReason(diagnostic)
              : undefined;
          if (reason !== undefined) {
            message.setReject(reason);
            return;
          }
          throw new Error(
            `Mail relay failed with status ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`,
          );
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        logger.error(
          `Cloudflare email relay failed: ${detail.slice(0, 1_200)}`,
        );
        throw cause;
      }
    },
  };
}

export default createEmailWorker();
