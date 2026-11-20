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
