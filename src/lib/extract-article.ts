import domPurify from "dompurify";
import { JSDOM } from "jsdom";
import { container } from "../container.ts";
import { Extractus } from "./extractors/extractus.ts";
import { MozillaReadabilityPlain } from "./extractors/mozilla-readability-plain.ts";
import { MozillaReadability } from "./extractors/mozilla-readability.ts";
import { Original } from "./extractors/original.ts";
import { DisplayMode } from "./settings.ts";

const displayModeToExtractor = {
  [DisplayMode.Extractus]: Extractus,
  [DisplayMode.Feed]: Original,
  [DisplayMode.Readability]: MozillaReadability,
  [DisplayMode.ReadabilityPlain]: MozillaReadabilityPlain,
} as const;

const window = new JSDOM("").window;
const purify = domPurify(window);

const getContent = async (
  content: null | string | undefined,
  articleUrl: string,
  displayMode: DisplayMode,
) => {
  if (displayMode === DisplayMode.Feed) {
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
