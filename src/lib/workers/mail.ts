/* eslint-disable n/callback-return */
import { type ArticlesRepository } from "$lib/db/article-repository";
import { type SourcesRepository } from "$lib/db/source-repository";
import { type Source } from "../../types/source-types";
import { logError as error_, llog } from "../../util/log";
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
  maxSizeBytes?: number | undefined;
};

export class MailWorker {
  private readonly config: MailWorkerConfig;

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
  }

  public initialize() {
    this.server = new SMTPServer({
      disabledCommands: ["AUTH"],
      onData: (emailStream, session, callback) => {
        (async () => {
          try {
            if (emailStream.sizeExceeded) {
              error_("Email size limit exceeded");
              callback(new Error("Email size limit exceeded"));
              return;
            }

            const email = await mailParser.simpleParser(emailStream);

            const senderAddress = session.envelope.mailFrom;
            if (!senderAddress) {
              callback(new Error("Unknown sender"));
              return;
            }

            const recipientMails = this.extractRecipientAddresses(email);
            if (recipientMails.length > 10) {
              callback(new Error("Too many recipients"));
              return;
            }

            const sources = (
              await Promise.all(
                recipientMails.map(async (address) => {
                  return await this.sourcesRepository.findSourceByUrl(address);
                }),
              )
            ).filter((source): source is Source => {
              return source !== undefined;
            });
            if (sources.length === 0) {
              callback(new Error("No recipients known"));
              return;
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
            callback();
          } catch (error: unknown) {
            error_("Failed to process incoming email:", error);
            emailStream.resume();
            await stream.finished(emailStream);
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      },
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
    });

    this.server.listen(25, () => {
      llog(`Mail server listening on port 25`);
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
      if (Array.isArray(addressObject?.value)) {
        for (const value of addressObject.value) {
          if (value.address) {
            recipientMails.push(value.address);
          }
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
