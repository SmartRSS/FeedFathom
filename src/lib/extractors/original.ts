import type { Extractor } from "./extractor.interface";

export class Original implements Extractor {
  async extract(content: string): Promise<string> {
    return content;
  }
}
