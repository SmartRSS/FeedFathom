export type Extractor = {
  extract: (content: string, articleUrl: string) => Promise<string> | string;
};
