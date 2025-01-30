import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";
import { DisplayMode } from "./settings";
import { MozillaReadability } from "./extractors/mozilla-readability";
import { MozillaReadabilityPlain } from "./extractors/mozilla-readability-plain";
import { Original } from "./extractors/original";
import { Extractus } from "./extractors/extractus";

const displayModeToExtractor = {
  [DisplayMode.READABILITY]: MozillaReadability,
  [DisplayMode.READABILITY_PLAIN]: MozillaReadabilityPlain,
  [DisplayMode.FEED]: Original,
  [DisplayMode.EXTRACTUS]: Extractus,
} as const;

export const extractArticle = async (
  content: string | null | undefined,
  articleUrl: string,
  displayMode: DisplayMode,
) => {
  if (!content) {
    return content;
  }
  const window = new JSDOM("").window;
  const purify = DOMPurify(window);
  const cleanContent = purify.sanitize(content);
  const extractor = new displayModeToExtractor[displayMode]();
  return extractor.extract(cleanContent, articleUrl);
};
