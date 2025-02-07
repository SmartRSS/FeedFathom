import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerSession,
} from "smtp-server";
import * as mailParser from "mailparser";
import type { Source } from "../../types/source-types";
import stream from "node:stream/promises";
import { err } from "../../util/log";
import type { SourcesRepository } from "$lib/db/source-repository";
import type { ArticleRepository } from "$lib/db/article-repository";

export interface MailWorkerConfig {
  maxSize?: number | undefined; // in bytes
  hostname?: string | undefined;
  allowedDomains?: string[] | undefined;
}

export class MailWorker {
  private server: SMTPServer | undefined;
  private config: MailWorkerConfig;

  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticleRepository,
    config: Partial<MailWorkerConfig> = {},
  ) {
    this.config = {
      maxSize: config.maxSize ?? 10 * 1024 * 1024,
      hostname: config.hostname,
      allowedDomains: config.allowedDomains,
    };
  }

  public initialize() {
    this.server = new SMTPServer({
      size: this.config.maxSize,
      disabledCommands: ["AUTH"],
      onRcptTo: async (
        _address: SMTPServerAddress,
        _session: SMTPServerSession,
        callback: (err?: Error) => void,
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
      onData: async (emailStream, session, callback) => {
        try {
          if (emailStream.sizeExceeded) {
            err("Email size limit exceeded");
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
          ).filter((source): source is Source => source !== undefined);
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
          err("Failed to process incoming email:", error);
          emailStream.resume();
          await stream.finished(emailStream);
          return callback(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    });

    this.server.listen(25, () => {
      console.log(`Mail server listening on port 25`);
    });
  }

  private extractRecipientAddresses(email: mailParser.ParsedMail): string[] {
    const recipients = Array.isArray(email.to) ? email.to : [email.to];
    const recipientMails: string[] = [];

    recipients.forEach((addressObject) => {
      addressObject?.value.forEach((value) => {
        if (value.address) {
          recipientMails.push(value.address);
        }
      });
    });

    return recipientMails;
  }

  private createArticleFromEmail(
    email: mailParser.ParsedMail,
    sourceId: number,
    senderAddress: string,
  ) {
    const guid = Bun.randomUUIDv7();
    const date = email.date ?? new Date();
    return {
      content: this.getEmailContent(email),
      guid: guid,
      sourceId: sourceId,
      title: email.subject ?? "Untitled",
      url: `/article/${guid}`,
      author: senderAddress,
      publishedAt: date,
      updatedAt: date,
    };
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

  public async shutdown(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }
}
