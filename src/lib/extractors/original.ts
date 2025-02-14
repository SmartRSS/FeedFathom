import { type Extractor } from "./extractor.interface";

export class Original implements Extractor {
  extract(content: string): string {
    return content;
  }
}
