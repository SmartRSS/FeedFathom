import type { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import type { SMTPServerAddress, SMTPServerSession } from "smtp-server";
import type { Source } from "../../types/source-types";
import type { ArticlesRepository } from "../db/article-repository";
import type { SourcesRepository } from "../db/source-repository";
import type { EmailProcessor } from "../email-processor";

/**
 * Branded type for GUIDs used in articles.
 */
export type ArticleGuid = string & { readonly __brand: unique symbol };

/**
 * Result of processing an email into articles.
 */
export type ProcessedArticles = {
  articles: ReturnType<EmailHandler["createArticles"]>;
  sender: string;
  sources: Source[];
  email: ParsedMail;
};

export class EmailHandler {
  constructor(
    private readonly emailProcessor: EmailProcessor,
    private readonly sourcesRepository: SourcesRepository,
    private readonly articlesRepository: ArticlesRepository,
  ) {}

  /**
   * Parses a raw email stream or buffer into a ParsedMail object.
   */
  public async parseEmail(input: Readable | Buffer): Promise<ParsedMail> {
    return await simpleParser(input);
  }

  /**
   * Validates the sender from the SMTP session.
   * Throws if sender is missing.
   */
  public validateSender(session: SMTPServerSession): SMTPServerAddress {
    const senderAddress = session.envelope.mailFrom;
    if (!senderAddress) {
      throw new Error("Unknown sender");
    }
    return senderAddress;
  }

  /**
   * Extracts recipient addresses from a parsed email.
   */
  public extractRecipientAddresses(email: ParsedMail): string[] {
    return this.emailProcessor.extractRecipientAddresses(email);
  }

  /**
   * Finds valid sources for the given email recipients.
   * Throws if no valid sources or too many recipients.
   */
  public async getValidSources(email: ParsedMail): Promise<Source[]> {
    const recipientMails = this.extractRecipientAddresses(email);
    if (recipientMails.length > 10) {
      throw new Error("Too many recipients");
    }
    const sources = (
      await Promise.all(
        recipientMails.map(async (address) => {
          return await this.sourcesRepository.findSourceByUrl(address);
        }),
      )
    ).filter((source): source is Source => source !== undefined);
    if (sources.length === 0) {
      throw new Error("No recipients known");
    }
    return sources;
  }

  /**
   * Creates an article object from a parsed email and source.
   */
  public createArticleFromEmail(
    email: ParsedMail,
    sourceId: number,
    senderAddress: string,
  ) {
    const guid = Bun.randomUUIDv7() as ArticleGuid;
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

  /**
   * Creates articles for all valid sources from a parsed email.
   */
  public createArticles(
    email: ParsedMail,
    sources: Source[],
    senderAddress: string,
  ) {
    return sources.map((feed) =>
      this.createArticleFromEmail(email, feed.id, senderAddress),
    );
  }

  /**
   * Processes a parsed email and upserts articles for all valid sources.
   * Returns the processed articles and context.
   */
  public async processParsedEmail(
    email: ParsedMail,
    senderAddress: string,
  ): Promise<ProcessedArticles> {
    const sources = await this.getValidSources(email);
    const articles = this.createArticles(email, sources, senderAddress);
    await this.articlesRepository.batchUpsertArticles(articles);
    return { articles, sender: senderAddress, sources, email };
  }
}
