import { Type } from "typebox";
import Schema from "typebox/schema";
import {
  checked,
  type WorkerRequestHandler,
  type WorkerRequests,
} from "#platform/worker-requests.ts";
import {
  type EmailHandler,
  MailRejectedError,
  type TrustedMailEnvelope,
} from "#features/mail-ingest/email-handler.ts";

enum MailRequestName {
  Ingest = "INGEST_MAIL",
}

const exact = { additionalProperties: false } as const;

const ingestRequestCheck = Schema.Compile(
  Type.Object(
    { from: Type.String(), raw: Type.String(), to: Type.String() },
    exact,
  ),
);
const ingestReplyCheck = Schema.Compile(
  Type.Union([
    Type.Object({ stored: Type.Literal(true) }, exact),
    Type.Object({ rejected: Type.String() }, exact),
  ]),
);

export class MailRequests {
  constructor(
    private readonly workerRequests: Pick<WorkerRequests, "request">,
  ) {}

  async ingest(base64Raw: string, envelope: TrustedMailEnvelope) {
    const reply = checked(
      ingestReplyCheck,
      await this.workerRequests.request(MailRequestName.Ingest, {
        from: envelope.from,
        raw: base64Raw,
        to: envelope.to,
      }),
      "mail ingest reply",
    );
    if ("rejected" in reply) throw new MailRejectedError(reply.rejected);
  }
}

export function createMailRequestHandlers(
  emailHandler: Pick<EmailHandler, "processEmail">,
): [string, WorkerRequestHandler][] {
  const ingest = async (data: unknown) => {
    const { from, raw, to } = checked(
      ingestRequestCheck,
      data,
      "mail ingest request",
    );
    try {
      await emailHandler.processEmail(Buffer.from(raw, "base64"), {
        from,
        to,
      });
      return { stored: true };
    } catch (error: unknown) {
      if (error instanceof MailRejectedError)
        return { rejected: error.message };
      throw error;
    }
  };
  return [[MailRequestName.Ingest, ingest]];
}
