import {
  mailRelaySecretHeader,
  maxRawEmailBytes,
} from "#shared/contracts/mail-relay.ts";
import { readResponseDiagnostic } from "#platform/http/read-response-diagnostic.ts";

// Deliberately hand-written rather than expressed as schemas: this module is
// bundled for Cloudflare, and pulling typebox in for three checks over strings
// and one integer put 372 KB of runtime type registry -- 98.7% of the bundle --
// on the cold start path. Nothing here is shared with the server: /api/mail
// validates the request it receives with its own contract.
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
  to: unknown;
};

// A URL's hostname keeps the brackets for an IPv6 literal, so `[::1]` is the
// form to compare against.
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

function mailEndpoint(domain: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(domain);
  } catch (cause) {
    throw new Error("MAIL_ENDPOINT_DOMAIN must be a valid URL origin", {
      cause,
    });
  }

  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("MAIL_ENDPOINT_DOMAIN must contain only a URL origin");
  }
  // Plaintext is allowed only where it cannot leave the host, because the
  // relay secret and the whole message travel in this request.
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && loopbackHosts.has(endpoint.hostname))
  ) {
    throw new Error("MAIL_ENDPOINT_DOMAIN must be https, or http on loopback");
  }

  endpoint.pathname = "/api/mail";
  return endpoint;
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
          throw new Error("Raw email exceeds 5 MiB");
        }

        const bytes = new Uint8Array(
          await new Response(message.raw).arrayBuffer(),
        );
        if (bytes.byteLength > maxRawEmailBytes) {
          throw new Error("Raw email exceeds 5 MiB");
        }

        const response = await fetcher(endpoint, {
          body: JSON.stringify({
            from: envelope.from,
            raw: toBase64(bytes),
            to: envelope.to,
          }),
          headers: {
            "content-type": "application/json",
            [mailRelaySecretHeader]: env.MAIL_RELAY_SECRET,
          },
          method: "POST",
        });
        if (!response.ok) {
          const diagnostic = await readResponseDiagnostic(response);
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
