import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";
import { DisplayMode } from "./settings";
import { MozillaReadability } from "./extractors/mozilla-readability";
import { MozillaReadabilityPlain } from "./extractors/mozilla-readability-plain";
import { Original } from "./extractors/original";
import { Extractus } from "./extractors/extractus";
import container from "../container";

const displayModeToExtractor = {
  [DisplayMode.READABILITY]: MozillaReadability,
  [DisplayMode.READABILITY_PLAIN]: MozillaReadabilityPlain,
  [DisplayMode.FEED]: Original,
  [DisplayMode.EXTRACTUS]: Extractus,
} as const;

const window = new JSDOM("").window;
const purify = DOMPurify(window);

const getContent = async (content: string | null | undefined,
  articleUrl: string,
  displayMode: DisplayMode,) => {
  if (displayMode === DisplayMode.FEED) {
    return purify.sanitize(content ?? "");
  }
  const response = await container.cradle.axiosInstance.get(articleUrl);
  if (response.status !== 200) {
    return "";
  }
  const originalContent = response.data;
  return purify.sanitize(originalContent);
}

export const extractArticle = async (
  content: string | null | undefined,
  articleUrl: string,
  displayMode: DisplayMode,
) => {
  const cleanContent = await getContent(content, articleUrl, displayMode);
  const extractor = new displayModeToExtractor[displayMode]();
  return extractor.extract(cleanContent, articleUrl);
};
