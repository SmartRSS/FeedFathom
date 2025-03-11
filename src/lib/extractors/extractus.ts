import { extractFromHtml } from "@extractus/article-extractor";
import type { Extractor } from "./extractor-interface.ts";

export class Extractus implements Extractor {
  async extract(content: string, articleUrl: string): Promise<string> {
    return (await extractFromHtml(content, articleUrl))?.content ?? "";
  }
}
