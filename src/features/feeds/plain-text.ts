import { decode } from "html-entities";

// An HTML start or end tag. The name must be followed by whitespace, "/" or
// ">", so an address in angle brackets ("Jane <jane@example.com>") is not
// mistaken for one.
const htmlTag = /<\/?[a-z][a-z0-9-]*(?:[\s/][^<>]*)?>/giu;

export const hasHtmlTag = (text: string) => new RegExp(htmlTag).test(text);

// For fields that are names, not prose: an author is never meant to show
// markup, so a tag in one is a publisher's template leaking through.
export const stripHtmlTags = (text: string) =>
  text.replaceAll(htmlTag, "").trim();

// One pass of HTML character-reference decoding over text that has already
// been XML-decoded. The feed library gives every feed title exactly this
// pass, so a title imported from OPML gets the same one.
export const decodeHtmlReferences = (text: string) => decode(text);

// Plain text as article HTML: escaped, so literal markup and entities survive,
// with its line breaks kept.
export const asHtmlText = (text: null | string | undefined): string | null =>
  typeof text === "string"
    ? Bun.escapeHTML(text).replaceAll(/\r\n?|\n/gu, "<br>")
    : null;
