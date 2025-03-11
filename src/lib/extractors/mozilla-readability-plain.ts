import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { Extractor } from "./extractor-interface.ts";

export class MozillaReadabilityPlain implements Extractor {
  extract(content: string, articleUrl: string): string {
    const document_ = new JSDOM(content, { url: articleUrl });
    const reader = new Readability(document_.window.document);
    return reader.parse()?.textContent ?? "";
  }
}
