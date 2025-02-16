import { type Extractor } from "./extractor-interface";
import { extractFromHtml } from "@extractus/article-extractor";

export class Extractus implements Extractor {
  async extract(content: string, articleUrl: string): Promise<string> {
    return (await extractFromHtml(content, articleUrl))?.content ?? "";
  }
}
