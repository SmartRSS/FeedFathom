import type { HttpResponse } from "#platform/http/http-client.ts";
import type { ArticleImporter } from "#features/feeds/article-import.ts";
import type { FeedParser } from "#features/feeds/feed-parser.ts";
import type { FeedPreviewCache } from "#features/feeds/feed-preview-cache.ts";
import type { OpmlNode } from "#features/feeds/opml-types.ts";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import { isNoAnswerError } from "#platform/http/http-deferred-error.ts";
import {
  checked,
  type WorkerRequestHandler,
  type WorkerRequests,
} from "#platform/worker-requests.ts";
import {
  foundFeedsResponse,
  previewResponse,
} from "#shared/contracts/responses.ts";
import { openRssSuggestion } from "#shared/scanners/scanner.ts";
import { decodeHtml } from "#shared/util/decode-body.ts";
import { plainTextPolicy } from "#shared/validation/typebox-policy.ts";
import { extractArticle } from "#features/feeds/extract-article.ts";
import { markWebSubAvailability } from "#features/feeds/feed-discovery.ts";
import {
  type FeedPreview,
  mapFeedToArticles,
} from "#features/feeds/feed-mapper.ts";
import { deserializeFeedPreview } from "#features/feeds/feed-preview-cache.ts";
import { scanHtml } from "#features/feeds/html-scanner.ts";
import { parseOpml } from "#features/feeds/opml-parser.ts";

enum FeedRequestName {
  Find = "FIND_FEEDS",
  ImportSnapshot = "IMPORT_SNAPSHOT",
  ParseOpml = "PARSE_OPML",
  Preview = "PREVIEW_FEED",
  Sanitize = "SANITIZE_ARTICLE",
}

const exact = { additionalProperties: false } as const;

const previewRequestCheck = Schema.Compile(
  Type.Object(
    { feedUrl: Type.String(), userId: Type.Integer({ minimum: 1 }) },
    exact,
  ),
);
const previewReplyCheck = Schema.Compile(
  Type.Union([
    Type.Object({ failure: Type.String() }, exact),
    Type.Object({ preview: previewResponse }, exact),
  ]),
);

const findRequestCheck = Schema.Compile(
  Type.Object({ link: Type.String() }, exact),
);
const findReplyCheck = Schema.Compile(
  Type.Union([
    Type.Object({ feeds: foundFeedsResponse }, exact),
    Type.Object({ invalid: Type.Literal(true) }, exact),
  ]),
);

const importSnapshotRequestCheck = Schema.Compile(
  Type.Object(
    {
      feedUrl: Type.String(),
      snapshot: Type.String(),
      sourceId: Type.Integer({ minimum: 1 }),
    },
    exact,
  ),
);
const importSnapshotReplyCheck = Schema.Compile(
  Type.Union([
    Type.Object({ imported: Type.Literal(true) }, exact),
    Type.Object({ invalid: Type.Literal(true) }, exact),
  ]),
);

const sanitizeRequestCheck = Schema.Compile(
  Type.Object({ content: Type.String() }, exact),
);
const sanitizeReplyCheck = Schema.Compile(
  Type.Object({ content: Type.String() }, exact),
);

const opmlRequestCheck = Schema.Compile(
  Type.Object({ opml: Type.String() }, exact),
);
const opmlNode = Type.Cyclic(
  {
    opmlNode: Type.Union([
      Type.Object(
        {
          children: Type.Array(Type.Ref("opmlNode")),
          name: Type.String(),
          type: Type.Literal("folder"),
        },
        exact,
      ),
      Type.Object(
        {
          homeUrl: Type.String(),
          name: Type.String(),
          type: Type.Literal("source"),
          xmlUrl: Type.String(),
        },
        exact,
      ),
    ]),
  },
  "opmlNode",
);
const opmlReplyCheck = Schema.Compile(
  Type.Union([
    Type.Object(
      { contentHash: Type.String(), tree: Type.Array(opmlNode) },
      exact,
    ),
    Type.Object(
      { invalid: Type.Union([Type.Literal("file"), Type.Literal("opml")]) },
      exact,
    ),
  ]),
);

export const isImportableSnapshot = (preview: FeedPreview) =>
  !preview.truncated || preview.feed !== undefined;

function completePreview({
  feed,
  finalUrl,
  ...preview
}: FeedPreview): FeedPreview | undefined {
  if (!preview.truncated) return preview;
  if (!feed) return undefined;
  return {
    ...preview,
    articles: mapFeedToArticles(feed, preview.feedUrl, {
      baseUrl: finalUrl,
    }),
    truncated: false,
  };
}

const sanitize = async (data: unknown) => {
  const { content } = checked(sanitizeRequestCheck, data, "sanitize request");
  return { content: extractArticle(content) };
};

const parseOpmlUpload = async (data: unknown) => {
  const { opml } = checked(opmlRequestCheck, data, "OPML request");
  const bytes = Buffer.from(opml, "base64");
  let tree: OpmlNode[];
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Value.Check(plainTextPolicy, content)) return { invalid: "file" };
    tree = parseOpml(content);
  } catch {
    return { invalid: "opml" };
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return { contentHash, tree };
};

export class FeedRequests {
  constructor(
    private readonly workerRequests: Pick<WorkerRequests, "request">,
  ) {}

  async preview(userId: number, feedUrl: string) {
    return checked(
      previewReplyCheck,
      await this.workerRequests.request(FeedRequestName.Preview, {
        feedUrl,
        userId,
      }),
      "preview reply",
    );
  }

  async find(link: string) {
    return checked(
      findReplyCheck,
      await this.workerRequests.request(FeedRequestName.Find, { link }),
      "find reply",
    );
  }

  async importSnapshot(sourceId: number, feedUrl: string, snapshot: string) {
    return checked(
      importSnapshotReplyCheck,
      await this.workerRequests.request(FeedRequestName.ImportSnapshot, {
        feedUrl,
        snapshot,
        sourceId,
      }),
      "snapshot import reply",
    );
  }

  async parseOpml(upload: Uint8Array) {
    return checked(
      opmlReplyCheck,
      await this.workerRequests.request(FeedRequestName.ParseOpml, {
        opml: Buffer.from(upload).toString("base64"),
      }),
      "OPML reply",
    );
  }

  async sanitize(content: string) {
    return checked(
      sanitizeReplyCheck,
      await this.workerRequests.request(FeedRequestName.Sanitize, { content }),
      "sanitize reply",
    ).content;
  }
}

export type FeedRequestHandlerServices = {
  articleImporter: Pick<ArticleImporter, "recordFetch">;
  feedParser: Pick<FeedParser, "parseUrl" | "preview">;
  feedPreviewCache: Pick<FeedPreviewCache, "save">;
  httpClient: {
    get(url: string): Promise<Pick<HttpResponse, "data" | "headers" | "url">>;
  };
};

export function createFeedRequestHandlers({
  articleImporter,
  feedParser,
  feedPreviewCache,
  httpClient,
}: FeedRequestHandlerServices): [string, WorkerRequestHandler][] {
  const preview = async (data: unknown) => {
    const { feedUrl, userId } = checked(
      previewRequestCheck,
      data,
      "preview request",
    );
    const source = await feedParser.preview(feedUrl);
    if ("failure" in source) return { failure: source.failure };
    await feedPreviewCache.save(userId, feedUrl, source);
    return {
      preview: {
        articles: source.articles.map((article) => ({
          author: article.author,
          content: extractArticle(article.content),
          enclosures: article.enclosures,
          publishedAt: article.publishedAt.toJSON(),
          title: article.title,
          url: article.url,
        })),
        description: source.description,
        feedUrl: source.feedUrl,
        link: source.link,
        title: source.title,
        truncated: source.truncated ?? false,
      },
    };
  };

  const find = async (data: unknown) => {
    const { link } = checked(findRequestCheck, data, "find request");
    try {
      const response = await httpClient.get(link);
      const html = decodeHtml(
        new Uint8Array(response.data),
        response.headers.get("content-type"),
      );
      const feeds = scanHtml(response.url, html);
      if (!feeds.length)
        return {
          feeds: [{ ...openRssSuggestion(response.url), websub: false }],
        };
      return { feeds: await markWebSubAvailability(feeds, feedParser) };
    } catch (error: unknown) {
      if (isNoAnswerError(error)) throw error;
      return { invalid: true };
    }
  };

  const importSnapshot = async (data: unknown) => {
    const { feedUrl, snapshot, sourceId } = checked(
      importSnapshotRequestCheck,
      data,
      "snapshot import request",
    );
    const stored = deserializeFeedPreview(snapshot, feedUrl);
    const complete = stored && completePreview(stored);
    if (!complete) return { invalid: true };
    await articleImporter.recordFetch(sourceId, complete.articles, {
      alwaysRecount: true,
      cached: true,
      freshUntil: complete.freshUntil,
      trigger: "poll",
    });
    return { imported: true };
  };

  return [
    [FeedRequestName.Find, find],
    [FeedRequestName.ImportSnapshot, importSnapshot],
    [FeedRequestName.ParseOpml, parseOpmlUpload],
    [FeedRequestName.Preview, preview],
    [FeedRequestName.Sanitize, sanitize],
  ];
}
