import type { Extractor } from "./extractor-interface.ts";

export class Original implements Extractor {
  extract(content: string): string {
    return content;
  }
}
