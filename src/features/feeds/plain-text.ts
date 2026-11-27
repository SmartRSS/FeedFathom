import { decodeHTML } from "entities";
import { decode } from "html-entities";

const htmlTag = /<\/?[a-z][a-z0-9-]*(?:[\s/][^<>]*)?>/giu;
const htmlTagTest = /<\/?[a-z][a-z0-9-]*(?:[\s/][^<>]*)?>/iu;
const surrogateOrMaxNumericReference =
  /&#(?:0*(?:5[567]\d{3}|1114111)|[xX]0*(?:[dD][89a-fA-F][\da-fA-F]{2}|10[fF]{4}))/;

export const hasHtmlTag = (text: string) =>
  text.includes("<") && htmlTagTest.test(text);

export const stripHtmlTags = (text: string) =>
  text.includes("<") ? text.replaceAll(htmlTag, "").trim() : text.trim();

export const decodeHtmlReferences = (text: string) =>
  text.includes("&#") && surrogateOrMaxNumericReference.test(text)
    ? decode(text)
    : decodeHTML(text);

export const asHtmlText = (text: null | string | undefined): string | null =>
  typeof text === "string"
    ? Bun.escapeHTML(text).replaceAll(/\r\n?|\n/gu, "<br>")
    : null;
