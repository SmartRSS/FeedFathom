import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerSession,
} from "smtp-server";
import * as mailParser from "mailparser";
import type { Source } from "../../types/source-types";
import type { Article } from "../../types/article.type";
import crypto from "node:crypto";
import stream from "node:stream/promises";
import { err } from "../../util/log";
import type { SourcesRepository } from "$lib/db/source-repository";
import type { ArticleRepository } from "$lib/db/article-repository";

export interface MailWorkerConfig {
  port: number;
  maxSize?: number | undefined;  // in bytes
  hostname?: string | undefined;
  allowedDomains?: string[] | undefined;
}

export class MailWorker {
  private server: SMTPServer | undefined;
  private config: MailWorkerConfig;

  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticleRepository,
    config: Partial<MailWorkerConfig> = {}
  ) {
    this.config = {
      port: typeof config.port === 'string' ? parseInt(config.port, 10) : (config.port ?? 25),
      maxSize: config.maxSize ?? 10 * 1024 * 1024,
      hostname: config.hostname,
      allowedDomains: config.allowedDomains,
    };
  }

  public initialize() {
    this.server = new SMTPServer({
      size: this.config.maxSize,
      disabledCommands: ["AUTH"],
      onRcptTo(
        _address: SMTPServerAddress,
        _session: SMTPServerSession,
        callback: (err?: Error) => void,
      ) {
        // Accept all recipient addresses
        callback();
      },
      onData: async (emailStream, session, callback) => {
        try {
          if (emailStream.sizeExceeded) {
            err('Email size limit exceeded');
            callback(new Error('Email size limit exceeded'));
            return;
          }

          const email = await mailParser.simpleParser(emailStream);
          
          const senderAddress = session.envelope.mailFrom as SMTPServerAddress;
          console.log(`Processing email from: ${senderAddress.address}`);

          const recipientMails = await this.extractRecipientAddresses(email);

          const sources = (
            await Promise.all(
              recipientMails.map(async (address) => {
                // const [_feedExternalId, _hostname] = address.split("@");
                // if (hostname !== application.configuration.hostname) return [];
                return await this.sourcesRepository.getSourceByAddress(address);
              }),
            )
          ).filter((source): source is Source => source !== undefined);
          if (sources.length === 0) {
            return;
          }
          for (const feed of sources) {
            const art = this.createArticleFromEmail(email, feed.id, senderAddress.address);
            await this.articlesRepository.batchUpsertArticles([art]);
          }
        } catch (error: unknown) {
          err('Failed to process incoming email:', error);
          callback(error instanceof Error ? error : new Error(String(error)));
          return;
        } finally {
          emailStream.resume();
          await stream.finished(emailStream);
          callback();
        }
      },
    });
    
    this.server.listen(this.config.port, () => {
      console.log(`Mail server listening on port ${this.config.port}`);
    });
  }

  private async extractRecipientAddresses(email: mailParser.ParsedMail): Promise<string[]> {
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
    senderAddress: string
  ): Omit<Article, "id"> {
    const guid = crypto.randomUUID();
    return {
      url: `/article/${guid}`,
      sourceId,
      guid,
      title: email.subject ?? "Untitled",
      author: senderAddress,
      publishedAt: new Date(),
      content: this.getEmailContent(email),
    };
  }

  private getEmailContent(email: mailParser.ParsedMail): string {
    if (typeof email.html === "string") return email.html;
    if (typeof email.textAsHtml === "string") return email.textAsHtml;
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
