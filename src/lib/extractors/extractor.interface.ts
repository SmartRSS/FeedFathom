export interface Extractor {
  extract: (content: string, articleUrl: string) => Promise<string>;
}
