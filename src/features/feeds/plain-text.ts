import { decode } from "html-entities";

const htmlTag = /<\/?[a-z][a-z0-9-]*(?:[\s/][^<>]*)?>/giu;

export const hasHtmlTag = (text: string) => new RegExp(htmlTag).test(text);

export const stripHtmlTags = (text: string) =>
  text.replaceAll(htmlTag, "").trim();

export const decodeHtmlReferences = (text: string) => decode(text);

export const asHtmlText = (text: null | string | undefined): string | null =>
  typeof text === "string"
    ? Bun.escapeHTML(text).replaceAll(/\r\n?|\n/gu, "<br>")
    : null;
