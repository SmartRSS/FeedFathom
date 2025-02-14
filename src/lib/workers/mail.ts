import { type ArticlesRepository } from "$lib/db/article-repository";
import { type SourcesRepository } from "$lib/db/source-repository";
import { type Source } from "../../types/source-types";
import { logError as error_ } from "../../util/log";
import * as mailParser from "mailparser";
import stream from "node:stream/promises";
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerSession,
} from "smtp-server";

export type MailWorkerConfig = {
  allowedDomains?: string[] | undefined;
  hostname?: string | undefined;
  maxSize?: number | undefined; // in bytes
}

export class MailWorker {
  private config: MailWorkerConfig;

  private server: SMTPServer | undefined;

  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticlesRepository,
    config: Partial<MailWorkerConfig> = {},
  ) {
    this.config = {
      allowedDomains: config.allowedDomains,
      hostname: config.hostname,
      maxSize: config.maxSize ?? 10 * 1_024 * 1_024,
    };
  }

  public initialize() {
    this.server = new SMTPServer({
      disabledCommands: ["AUTH"],
      onData: async (emailStream, session, callback) => {
        try {
          if (emailStream.sizeExceeded) {
            error_("Email size limit exceeded");
            return callback(new Error("Email size limit exceeded"));
          }

          const email = await mailParser.simpleParser(emailStream);

          const senderAddress = session.envelope.mailFrom;
          if (!senderAddress) {
            return callback(new Error("Unknown sender"));
          }

          const recipientMails = this.extractRecipientAddresses(email);
          if (recipientMails.length > 10) {
            return callback(new Error("Too many recipients"));
          }

          const sources = (
            await Promise.all(
              recipientMails.map(async (address) => {
                return await this.sourcesRepository.findSourceByUrl(address);
              }),
            )
          ).filter((source): source is Source => {return source !== undefined});
          if (sources.length === 0) {
            return callback(new Error("No recipients known"));
          }

          const articles = sources.map((feed) => {
            return this.createArticleFromEmail(
              email,
              feed.id,
              senderAddress.address,
            );
          });

          await this.articlesRepository.batchUpsertArticles(articles);
          emailStream.resume();
          await stream.finished(emailStream);
          return callback();
        } catch (error: unknown) {
          error_("Failed to process incoming email:", error);
          emailStream.resume();
          await stream.finished(emailStream);
          return callback(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
      onRcptTo: async (
        _address: SMTPServerAddress,
        _session: SMTPServerSession,
        callback: (error?: Error) => void,
      ) => {
        try {
          const source = await this.sourcesRepository.findSourceByUrl(
            _address.address,
          );
          if (!source) {
            return callback(new Error("Unknown recipient"));
          }

          return callback();
        } catch (error: unknown) {
          return callback(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
      size: this.config.maxSize,
    });

    this.server.listen(25, () => {
      console.log(`Mail server listening on port 25`);
    });
  }

  public async shutdown(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {return resolve()});
      });
    }
  }

  private createArticleFromEmail(
    email: mailParser.ParsedMail,
    sourceId: number,
    senderAddress: string,
  ) {
    const guid = Bun.randomUUIDv7();
    const date = email.date ?? new Date();
    return {
      author: senderAddress,
      content: this.getEmailContent(email),
      guid,
      publishedAt: date,
      sourceId,
      title: email.subject ?? "Untitled",
      updatedAt: date,
      url: `/article/${guid}`,
    };
  }

  private extractRecipientAddresses(email: mailParser.ParsedMail): string[] {
    const recipients = Array.isArray(email.to) ? email.to : [email.to];
    const recipientMails: string[] = [];

    for (const addressObject of recipients) {
      for (const value of addressObject?.value) {
        if (value.address) {
          recipientMails.push(value.address);
        }
      }
    }

    return recipientMails;
  }

  private getEmailContent(email: mailParser.ParsedMail): string {
    if (typeof email.html === "string") {
      return email.html;
    }

    if (typeof email.textAsHtml === "string") {
      return email.textAsHtml;
    }

    return "No content.";
  }
}
