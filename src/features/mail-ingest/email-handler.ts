import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { ArticlesDataService } from "#features/feeds/article-data-service.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import {
  getEmailContent,
  validateParsedMail,
} from "#features/mail-ingest/email-processor.ts";

export type TrustedMailEnvelope = {
  from: string;
  to: string;
};

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const emailGuid = (
  email: ParsedMail,
  raw: Buffer,
  sourceId: number,
): string => {
  const messageId = email.messageId
    ?.trim()
    .replace(/^<|>$/g, "")
    .trim()
    .toLowerCase();
  return messageId
    ? `email:${sourceId}:message-id:${sha256(messageId)}`
    : `email:${sourceId}:raw:${sha256(raw)}`;
};

const readEmail = async (input: Readable | Buffer): Promise<Buffer> => {
  if (Buffer.isBuffer(input)) return input;
  const chunks: Buffer[] = [];
  for await (const value of input) {
    const chunk: unknown = value;
    if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw new Error("Email stream must emit raw bytes");
  }
  return Buffer.concat(chunks);
};

export class EmailHandler {
  constructor(
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "findSourceByUrl" | "successSource"
    >,
    private readonly articlesDataService: Pick<
      ArticlesDataService,
      "batchUpsertArticles"
    >,
    private readonly userSourcesDataService: Pick<
      UserSourcesDataService,
      "recomputeUnreadCounts"
    >,
  ) {}

  public async processEmail(
    input: Readable | Buffer,
    envelope: TrustedMailEnvelope,
  ): Promise<void> {
    const raw = await readEmail(input);
    const email = await simpleParser(raw);
    validateParsedMail(email);
    const source = await this.sourcesDataService.findSourceByUrl(envelope.to);
    if (!source) throw new Error("No recipients known");

    const article = this.createArticleFromEmail(
      email,
      emailGuid(email, raw, source.id),
      source.id,
      envelope.from,
    );
    await this.articlesDataService.batchUpsertArticles([article]);
    await this.userSourcesDataService.recomputeUnreadCounts([source.id]);
    await this.sourcesDataService.successSource(
      source.id,
      false,
      undefined,
      new Date(),
      "email",
    );
  }

  private createArticleFromEmail(
    email: ParsedMail,
    guid: string,
    sourceId: number,
    senderAddress: string,
  ) {
    validateParsedMail(email);
    const date = email.date ?? new Date();
    return {
      author: senderAddress,
      content: getEmailContent(email),
      guid,
      lastSeenInFeedAt: new Date(),
      publishedAt: date,
      sourceId,
      title: email.subject ?? "Untitled",
      updatedAt: date,
      url: `/article/${guid}`,
    };
  }
}
