import container from "../container";
import { Extractus } from "./extractors/extractus";
import { MozillaReadability } from "./extractors/mozilla-readability";
import { MozillaReadabilityPlain } from "./extractors/mozilla-readability-plain";
import { Original } from "./extractors/original";
import { DisplayMode } from "./settings";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const displayModeToExtractor = {
  [DisplayMode.EXTRACTUS]: Extractus,
  [DisplayMode.FEED]: Original,
  [DisplayMode.READABILITY]: MozillaReadability,
  [DisplayMode.READABILITY_PLAIN]: MozillaReadabilityPlain,
} as const;

const window = new JSDOM("").window;
const purify = DOMPurify(window);

const getContent = async (
  content: null | string | undefined,
  articleUrl: string,
  displayMode: DisplayMode,
) => {
  if (displayMode === DisplayMode.FEED) {
    return purify.sanitize(content ?? "");
  }

  const response = await container.cradle.axiosInstance.get(articleUrl);
  if (response.status !== 200) {
    return "";
  }

  if (typeof response.data !== "string") {
    return "";
  }

  const originalContent = response.data;
  return purify.sanitize(originalContent);
};

export const extractArticle = async (
  content: null | string | undefined,
  articleUrl: string,
  displayMode: DisplayMode,
) => {
  const cleanContent = await getContent(content, articleUrl, displayMode);
  const extractor = new displayModeToExtractor[displayMode]();
  return await extractor.extract(cleanContent, articleUrl);
};
