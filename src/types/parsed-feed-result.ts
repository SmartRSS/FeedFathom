export type ParsedFeedInfo = {
  title: string;
  description?: string | undefined;
  link: string;
  language?: string | undefined;
  image?: string | undefined;
};

export type ParsedFeedArticle = {
  guid: string;
  sourceId: number;
  title: string;
  url: string;
  author: string;
  publishedAt: Date;
  content: string;
  updatedAt: Date;
  lastSeenInFeedAt: Date;
};

export type ParsedFeedResult = {
  feedInfo: ParsedFeedInfo;
  articles: ParsedFeedArticle[];
};
