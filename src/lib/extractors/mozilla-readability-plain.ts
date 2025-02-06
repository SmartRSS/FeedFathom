import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { Extractor } from "./extractor.interface";

export class MozillaReadabilityPlain implements Extractor {
  extract(content: string, articleUrl: string): string {
    const doc = new JSDOM(content, { url: articleUrl });
    const reader = new Readability(doc.window.document);
    return reader.parse()?.textContent ?? "";
  }
}
