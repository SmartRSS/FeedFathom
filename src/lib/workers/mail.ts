import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ArticlesRepository } from "$lib/db/article-repository";
import type { SourcesRepository } from "$lib/db/source-repository";
import { EmailProcessor } from "$lib/email-processor";
import { type ParsedMail, simpleParser } from "mailparser";
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerSession,
} from "smtp-server";
import type { Source } from "../../types/source-types.ts";
import { logError as error_, llog } from "../../util/log.ts";

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

  private server: SMTPServer | undefined;

  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticlesRepository,
    config: Partial<MailWorkerConfig> = {}
  ) {
    this.config = {
      allowedDomains: config.allowedDomains,
      hostname: config.hostname,
      maxSizeBytes: config.maxSizeBytes ?? 10 * 1_024 * 1_024,
    };
    this.emailProcessor = new EmailProcessor();
  }

  public initialize() {
    this.server = new SMTPServer({
      disabledCommands: ["AUTH"],
      onData: this.handleEmailData.bind(this),
      onRcptTo: (
        _address: SMTPServerAddress,
        _session: SMTPServerSession,
        callback: (error?: Error) => void
      ) => {
        (async () => {
          try {
            const source = await this.sourcesRepository.findSourceByUrl(
              _address.address
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

  private createArticleFromEmail(
    email: ParsedMail,
    sourceId: number,
    senderAddress: string
  ) {
    const guid = Bun.randomUUIDv7();
    const date = email.date ?? new Date();
    return {
      author: senderAddress,
      content: this.emailProcessor.getEmailContent(email),
      guid,
      publishedAt: date,
      sourceId,
      title: email.subject ?? "Untitled",
      updatedAt: date,
      url: `/article/${guid}`,
    };
  }

  private createArticles(
    email: ParsedMail,
    sources: Source[],
    senderAddress: string
  ) {
    return sources.map((feed) => {
      return this.createArticleFromEmail(email, feed.id, senderAddress);
    });
  }

  private extractRecipientAddresses(email: ParsedMail): string[] {
    return this.emailProcessor.extractRecipientAddresses(email);
  }

  private async finalizeEmailProcessing(
    emailStream: EmailStream
  ): Promise<void> {
    emailStream.resume();
    await finished(emailStream);
  }

  private async getValidSources(email: ParsedMail): Promise<Source[]> {
    const recipientMails = this.extractRecipientAddresses(email);
    if (recipientMails.length > 10) {
      throw new Error("Too many recipients");
    }

    const sources = (
      await Promise.all(
        recipientMails.map(async (address) => {
          return await this.sourcesRepository.findSourceByUrl(address);
        })
      )
    ).filter((source): source is Source => {
      return source !== undefined;
    });

    if (sources.length === 0) {
      throw new Error("No recipients known");
    }

    return sources;
  }

  private handleEmailData(
    emailStream: EmailStream,
    session: SMTPServerSession,
    callback: (error?: Error) => void
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
    callback: (error?: Error) => void
  ): Promise<void> {
    error_("Failed to process incoming email:", error);
    await this.finalizeEmailProcessing(emailStream);
    callback(error instanceof Error ? error : new Error(String(error)));
  }

  private async processEmailStream(
    emailStream: EmailStream,
    session: SMTPServerSession,
    callback: (error?: Error) => void
  ): Promise<void> {
    if (emailStream.sizeExceeded) {
      error_("Email size limit exceeded");
      throw new Error("Email size limit exceeded");
    }

    const email = await simpleParser(emailStream);
    const senderAddress = this.validateSender(session);
    const sources = await this.getValidSources(email);
    const articles = this.createArticles(email, sources, senderAddress.address);

    await this.articlesRepository.batchUpsertArticles(articles);
    await this.finalizeEmailProcessing(emailStream);
    callback();
  }

  private validateSender(session: SMTPServerSession): SMTPServerAddress {
    const senderAddress = session.envelope.mailFrom;
    if (!senderAddress) {
      throw new Error("Unknown sender");
    }

    return senderAddress;
  }
}
