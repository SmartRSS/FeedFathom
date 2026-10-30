import { createHash } from "node:crypto";
import type { Buffer } from "node:buffer";
import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { dateType } from "#shared/validation/typebox-policy.ts";
import type { SourcesDataService } from "#features/feeds/source-data-service.ts";
import type { ArticleImporter } from "#features/feeds/article-import.ts";

// The fields read off mailparser's result, checked rather than trusted: the
// parser's types promise more than its runtime guarantees.
const parsedMailCheck = Schema.Compile(
  Type.Object(
    {
      date: Type.Optional(Type.Union([dateType, Type.Undefined()])),
      html: Type.Union([Type.String(), Type.Literal(false)]),
      subject: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
      textAsHtml: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    },
    { additionalProperties: true },
  ),
);

export type TrustedMailEnvelope = {
  from: string;
  to: string;
};

// The message itself is unacceptable: the same bytes to the same address would
// fail again, so the relay is told to bounce it rather than retry. The error
// hook maps it to 422.
export class MailRejectedError extends Error {
  override name = "MailRejectedError";
}

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

export class EmailHandler {
  constructor(
    private readonly sourcesDataService: Pick<
      SourcesDataService,
      "findSourceByUrl" | "successSource"
    >,
    private readonly articleImporter: Pick<ArticleImporter, "importArticles">,
    // A seam for the projection check below, which no real message reaches.
    private readonly parse: (raw: Buffer) => Promise<ParsedMail> = simpleParser,
  ) {}

  public async processEmail(
    raw: Buffer,
    envelope: TrustedMailEnvelope,
  ): Promise<void> {
    const email = await this.parse(raw);
    if (!parsedMailCheck.Check(email)) {
      throw new MailRejectedError(
        "Mail parser returned an invalid message projection",
      );
    }
    const source = await this.sourcesDataService.findSourceByUrl(envelope.to);
    if (!source) throw new MailRejectedError("No recipients known");

    const article = this.createArticleFromEmail(
      email,
      emailGuid(email, raw, source.id),
      source.id,
      envelope.from,
    );
    await this.articleImporter.importArticles(source.id, [article], {
      alwaysRecount: true,
    });
    await this.sourcesDataService.successSource(source.id, {
      trigger: "email",
    });
  }

  private createArticleFromEmail(
    email: Pick<ParsedMail, "date" | "html" | "subject" | "textAsHtml">,
    guid: string,
    sourceId: number,
    senderAddress: string,
  ) {
    const date = email.date ?? new Date();
    return {
      author: senderAddress,
      content:
        typeof email.html === "string"
          ? email.html
          : (email.textAsHtml ?? "No content."),
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
