import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ArticlesRepository } from "$lib/db/article-repository.ts";
import type { SourcesRepository } from "$lib/db/source-repository.ts";
import { EmailProcessor } from "$lib/email-processor.ts";
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerSession,
} from "smtp-server";
import { logError as error_, llog } from "../../util/log.ts";
import { EmailHandler } from "../email/email-handler.ts";

export type MailWorkerConfig = {
  allowedDomains?: string[] | undefined;
  hostname?: string | undefined;
  maxSizeBytes?: number | undefined;
};

type EmailStream = Readable & {
  sizeExceeded?: boolean;
};

export class MailWorker {
  private readonly config: MailWorkerConfig;

  private readonly emailProcessor: EmailProcessor;

  private readonly emailHandler: EmailHandler;

  private server: SMTPServer | undefined;

  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticlesRepository,
    config: Partial<MailWorkerConfig> = {},
  ) {
    this.config = {
      allowedDomains: config.allowedDomains,
      hostname: config.hostname,
      maxSizeBytes: config.maxSizeBytes ?? 10 * 1_024 * 1_024,
    };
    this.emailProcessor = new EmailProcessor();
    this.emailHandler = new EmailHandler(
      this.emailProcessor,
      this.sourcesRepository,
      this.articlesRepository,
    );
  }

  public initialize() {
    this.server = new SMTPServer({
      disabledCommands: ["AUTH"],
      onData: this.handleEmailData.bind(this),
      onRcptTo: (
        _address: SMTPServerAddress,
        _session: SMTPServerSession,
        callback: (error?: Error) => void,
      ) => {
        (async () => {
          try {
            const source = await this.sourcesRepository.findSourceByUrl(
              _address.address,
            );
            if (!source) {
              callback(new Error("Unknown recipient"));
              return;
            }

            callback();
          } catch (error: unknown) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
      size: this.config.maxSizeBytes,
      socketTimeout: 60000,
    });

    this.server.listen(25, () => {
      llog("Mail server listening on port 25");
    });
  }

  public async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      }
    });
  }

  private async finalizeEmailProcessing(
    emailStream: EmailStream,
  ): Promise<void> {
    emailStream.resume();
    await finished(emailStream);
  }

  private handleEmailData(
    emailStream: EmailStream,
    session: SMTPServerSession,
    callback: (error?: Error) => void,
  ): void {
    (async () => {
      try {
        await this.processEmailStream(emailStream, session, callback);
      } catch (error: unknown) {
        await this.handleEmailError(error, emailStream, callback);
      }
    })();
  }

  private async handleEmailError(
    error: unknown,
    emailStream: EmailStream,
    callback: (error?: Error) => void,
  ): Promise<void> {
    error_("Failed to process incoming email:", error);
    await this.finalizeEmailProcessing(emailStream);
    callback(error instanceof Error ? error : new Error(String(error)));
  }

  private async processEmailStream(
    emailStream: EmailStream,
    session: SMTPServerSession,
    callback: (error?: Error) => void,
  ): Promise<void> {
    if (emailStream.sizeExceeded) {
      error_("Email size limit exceeded");
      throw new Error("Email size limit exceeded");
    }

    const email = await this.emailHandler.parseEmail(emailStream);
    const senderAddress = this.emailHandler.validateSender(session);
    await this.emailHandler.processParsedEmail(email, senderAddress.address);
    await this.finalizeEmailProcessing(emailStream);
    callback();
  }
}
