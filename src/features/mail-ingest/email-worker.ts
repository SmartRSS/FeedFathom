import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  mailRelaySecretHeader,
  maxRawEmailBytes,
  maxRelayPayloadChars,
} from "#shared/contracts/mail-relay.ts";
import { readResponseDiagnostic } from "#platform/http/read-response-diagnostic.ts";

const endpointDomain = Type.Union([
  Type.String({ pattern: "^https://" }),
  Type.String({
    pattern:
      "^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[1-9]\\d{0,4})?/?$",
  }),
]);
const workerEnvironment = Type.Object(
  {
    MAIL_ENDPOINT_DOMAIN: endpointDomain,
    MAIL_RELAY_SECRET: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: true },
);
const incomingMessageProjection = Type.Object(
  {
    from: Type.String({ minLength: 1, pattern: "\\S" }),
    rawSize: Type.Integer({ minimum: 0 }),
    to: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
);
const outgoingMailPayload = Type.Object(
  {
    from: Type.String({ minLength: 1, pattern: "\\S" }),
    raw: Type.String({ maxLength: maxRelayPayloadChars, minLength: 1 }),
    to: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
);

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

type ErrorLogger = {
  error(message: string): void;
};

export type IncomingEmailMessage = {
  from: unknown;
  raw: BodyInit | null;
  rawSize: unknown;
  to: unknown;
};

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
        if (!Value.Check(workerEnvironment, env)) {
          throw new Error("Invalid Cloudflare email worker environment");
        }

        const projection = {
          from: message.from,
          rawSize: message.rawSize,
          to: message.to,
        };
        if (!Value.Check(incomingMessageProjection, projection)) {
          throw new Error("Invalid incoming email message");
        }
        if (projection.rawSize > maxRawEmailBytes) {
          throw new Error("Raw email exceeds 5 MiB");
        }

        const bytes = new Uint8Array(
          await new Response(message.raw).arrayBuffer(),
        );
        if (bytes.byteLength > maxRawEmailBytes) {
          throw new Error("Raw email exceeds 5 MiB");
        }
        const payload = {
          from: projection.from,
          raw: toBase64(bytes),
          to: projection.to,
        };
        if (!Value.Check(outgoingMailPayload, payload)) {
          throw new Error("Invalid outgoing mail relay payload");
        }

        const response = await fetcher(mailEndpoint(env.MAIL_ENDPOINT_DOMAIN), {
          body: JSON.stringify(payload),
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
