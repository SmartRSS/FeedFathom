import { decodeHTML, decodeHTMLAttribute } from "entities";
import { Tokenizer } from "htmlparser2";

const allowedTags = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

const selfClosingTags = new Set(["br", "col", "hr", "img"]);
const nonTextTags = new Set(["option", "script", "style", "textarea", "xmp"]);

const allowedAttributesByTag: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "name", "rel", "target"]),
  audio: new Set(["controls", "src"]),
  img: new Set([
    "alt",
    "decoding",
    "height",
    "loading",
    "sizes",
    "src",
    "srcset",
    "title",
    "width",
  ]),
  source: new Set(["sizes", "src", "srcset", "type"]),
  video: new Set(["controls", "height", "poster", "src", "width"]),
};

const urlAttributes = new Set(["href", "poster", "src"]);
const allowedSchemes = new Set(["http", "https", "mailto"]);

const formTags = new Set([
  "button",
  "datalist",
  "input",
  "optgroup",
  "option",
  "select",
  "textarea",
]);
const pTag = new Set(["p"]);
const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p"]);
const tableSectionTags = new Set(["tbody", "thead"]);
const ddtTags = new Set(["dd", "dt"]);
const rtpTags = new Set(["rp", "rt"]);

const openImpliesClose = new Map<string, ReadonlySet<string>>([
  ["tr", new Set(["td", "th", "tr"])],
  ["th", new Set(["th"])],
  ["td", new Set(["td", "th", "thead"])],
  ["body", new Set(["head", "link", "script"])],
  ["a", new Set(["a"])],
  ["li", new Set(["li"])],
  ["p", pTag],
  ["h1", headingTags],
  ["h2", headingTags],
  ["h3", headingTags],
  ["h4", headingTags],
  ["h5", headingTags],
  ["h6", headingTags],
  ["select", formTags],
  ["input", formTags],
  ["output", formTags],
  ["button", formTags],
  ["datalist", formTags],
  ["textarea", formTags],
  ["option", new Set(["option"])],
  ["optgroup", new Set(["optgroup", "option"])],
  ["dd", ddtTags],
  ["dt", ddtTags],
  ["address", pTag],
  ["article", pTag],
  ["aside", pTag],
  ["blockquote", pTag],
  ["details", pTag],
  ["div", pTag],
  ["dl", pTag],
  ["fieldset", pTag],
  ["figcaption", pTag],
  ["figure", pTag],
  ["footer", pTag],
  ["form", pTag],
  ["header", pTag],
  ["hr", pTag],
  ["main", pTag],
  ["nav", pTag],
  ["ol", pTag],
  ["pre", pTag],
  ["section", pTag],
  ["table", pTag],
  ["ul", pTag],
  ["rt", rtpTags],
  ["rp", rtpTags],
  ["tbody", tableSectionTags],
  ["tfoot", tableSectionTags],
]);

const voidElements = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const foreignContextElements = new Set(["math", "svg"]);
const htmlIntegrationElements = new Set([
  "annotation-xml",
  "desc",
  "foreignObject",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "title",
]);
const svgTagNameAdjustments = new Map<string, string>([
  ["altglyph", "altGlyph"],
  ["altglyphdef", "altGlyphDef"],
  ["altglyphitem", "altGlyphItem"],
  ["animatecolor", "animateColor"],
  ["animatemotion", "animateMotion"],
  ["animatetransform", "animateTransform"],
  ["clippath", "clipPath"],
  ["feblend", "feBlend"],
  ["fecolormatrix", "feColorMatrix"],
  ["fecomponenttransfer", "feComponentTransfer"],
  ["fecomposite", "feComposite"],
  ["feconvolvematrix", "feConvolveMatrix"],
  ["fediffuselighting", "feDiffuseLighting"],
  ["fedisplacementmap", "feDisplacementMap"],
  ["fedistantlight", "feDistantLight"],
  ["fedropshadow", "feDropShadow"],
  ["feflood", "feFlood"],
  ["fefunca", "feFuncA"],
  ["fefuncb", "feFuncB"],
  ["fefuncg", "feFuncG"],
  ["fefuncr", "feFuncR"],
  ["fegaussianblur", "feGaussianBlur"],
  ["feimage", "feImage"],
  ["femerge", "feMerge"],
  ["femergenode", "feMergeNode"],
  ["femorphology", "feMorphology"],
  ["feoffset", "feOffset"],
  ["fepointlight", "fePointLight"],
  ["fespecularlighting", "feSpecularLighting"],
  ["fespotlight", "feSpotLight"],
  ["fetile", "feTile"],
  ["feturbulence", "feTurbulence"],
  ["foreignobject", "foreignObject"],
  ["glyphref", "glyphRef"],
  ["lineargradient", "linearGradient"],
  ["radialgradient", "radialGradient"],
  ["textpath", "textPath"],
]);

const foreignNone = 0;
const foreignSvg = 1;
const foreignMathMl = 2;

const maxIframeFallbackDepth = 8;

const flagAllowed = 1;
const flagVoid = 2;
const flagSelfClosing = 4;
const flagHasAttrs = 8;
const flagImpliesClose = 16;
const flagRawText = 32;
const flagNonText = 64;
const flagForeignChange = 128;
const flagFallback = 256;

const rawTextClosePatterns: Readonly<Record<string, RegExp>> = {
  iframe: /<\/iframe[\t\n\f\r />]/gi,
  script: /<\/script[\t\n\f\r />]/gi,
  style: /<\/style[\t\n\f\r />]/gi,
  textarea: /<\/textarea[\t\n\f\r />]/gi,
  title: /<\/title[\t\n\f\r />]/gi,
  xmp: /<\/xmp[\t\n\f\r />]/gi,
};

const tagFlags = new Map<string, number>();
const addFlag = (tag: string, flag: number) => {
  tagFlags.set(tag, (tagFlags.get(tag) ?? 0) | flag);
};
for (const tag of allowedTags) addFlag(tag, flagAllowed);
for (const tag of voidElements) addFlag(tag, flagVoid);
for (const tag of selfClosingTags) addFlag(tag, flagSelfClosing);
for (const tag of Object.keys(allowedAttributesByTag))
  addFlag(tag, flagHasAttrs);
for (const tag of openImpliesClose.keys()) addFlag(tag, flagImpliesClose);
for (const tag of Object.keys(rawTextClosePatterns)) addFlag(tag, flagRawText);
for (const tag of nonTextTags) addFlag(tag, flagNonText);
for (const tag of foreignContextElements) addFlag(tag, flagForeignChange);
for (const tag of htmlIntegrationElements) addFlag(tag, flagForeignChange);
for (const tag of ["noembed", "noframes", "plaintext"])
  addFlag(tag, flagFallback);

const textEscapePattern = /[&<>]/;
const textEscapeGlobal = /[&<>]/g;
const attrEscapePattern = /[&<>"]/;
const attrEscapeGlobal = /[&<>"]/g;

const escapeChar = (ch: string): string => {
  switch (ch) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    default:
      return ch;
  }
};

const escapeText = (text: string): string =>
  textEscapePattern.test(text)
    ? text.replaceAll(textEscapeGlobal, escapeChar)
    : text;

const escapeAttr = (value: string): string =>
  attrEscapePattern.test(value)
    ? value.replaceAll(attrEscapeGlobal, escapeChar)
    : value;

const controlCharsPattern = /[\x00-\x20]+/g;
const schemePattern = /^([a-zA-Z][a-zA-Z0-9.\-+]*):/;

const isNaughtyHref = (href: string): boolean => {
  let cleaned = controlCharsPattern.test(href)
    ? href.replaceAll(controlCharsPattern, "")
    : href;
  controlCharsPattern.lastIndex = 0;
  if (cleaned.includes("<!--")) {
    let firstIndex = cleaned.indexOf("<!--");
    while (firstIndex !== -1) {
      const lastIndex = cleaned.indexOf("-->", firstIndex + 4);
      if (lastIndex === -1) break;
      cleaned = cleaned.slice(0, firstIndex) + cleaned.slice(lastIndex + 3);
      firstIndex = cleaned.indexOf("<!--");
    }
  }
  const match = schemePattern.exec(cleaned);
  if (!match) return false;
  return !allowedSchemes.has(match[1]!.toLowerCase());
};

const isSrcsetSpace = (code: number): boolean =>
  code === 0x20 ||
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0c ||
  code === 0x0d;

const nonNegativeIntPattern = /^\d+$/;
const floatingPointPattern =
  /^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

const sanitizeSrcset = (input: string): string | null => {
  const len = input.length;
  let pos = 0;
  const parts: string[] = [];

  const pushCandidate = (url: string, descriptors: readonly string[]) => {
    let pError = false;
    let width: number | undefined;
    let density: number | undefined;
    let height: number | undefined;

    for (const desc of descriptors) {
      const lastChar = desc.at(-1);
      const val = desc.slice(0, -1);
      if (lastChar === "w" && nonNegativeIntPattern.test(val)) {
        const intVal = Number.parseInt(val, 10);
        if (width !== undefined || density !== undefined || intVal === 0) {
          pError = true;
        } else {
          width = intVal;
        }
      } else if (lastChar === "x" && floatingPointPattern.test(val)) {
        const floatVal = Number.parseFloat(val);
        if (
          width !== undefined ||
          density !== undefined ||
          height !== undefined ||
          floatVal < 0
        ) {
          pError = true;
        } else {
          density = floatVal;
        }
      } else if (lastChar === "h" && nonNegativeIntPattern.test(val)) {
        const intVal = Number.parseInt(val, 10);
        if (height !== undefined || density !== undefined || intVal === 0) {
          pError = true;
        } else {
          height = intVal;
        }
      } else {
        pError = true;
      }
    }

    if (pError || !url || isNaughtyHref(url)) return;
    parts.push(
      url +
        (width ? ` ${width}w` : "") +
        (height ? ` ${height}h` : "") +
        (density ? ` ${density}x` : ""),
    );
  };

  while (pos < len) {
    while (pos < len) {
      const c = input.charCodeAt(pos);
      if (c === 0x2c || isSrcsetSpace(c)) pos++;
      else break;
    }
    if (pos >= len) break;

    const urlStart = pos;
    while (pos < len && !isSrcsetSpace(input.charCodeAt(pos))) pos++;
    let url = input.slice(urlStart, pos);

    if (url.endsWith(",")) {
      let end = url.length;
      while (end > 0 && url.charCodeAt(end - 1) === 0x2c) end--;
      url = url.slice(0, end);
      pushCandidate(url, []);
      continue;
    }

    while (pos < len && isSrcsetSpace(input.charCodeAt(pos))) pos++;

    const descriptors: string[] = [];
    let current = "";
    let state = 0;

    while (true) {
      const atEnd = pos >= len;
      const code = atEnd ? -1 : input.charCodeAt(pos);

      if (state === 0) {
        if (atEnd) {
          if (current) descriptors.push(current);
          break;
        }
        if (isSrcsetSpace(code)) {
          if (current) {
            descriptors.push(current);
            current = "";
            state = 2;
          }
        } else if (code === 0x2c) {
          pos++;
          if (current) descriptors.push(current);
          break;
        } else if (code === 0x28) {
          current += "(";
          state = 1;
        } else {
          current += input[pos]!;
        }
      } else if (state === 1) {
        if (atEnd) {
          descriptors.push(current);
          break;
        }
        current += input[pos]!;
        if (code === 0x29) state = 0;
      } else {
        if (atEnd) break;
        if (!isSrcsetSpace(code)) {
          state = 0;
          pos--;
        }
      }
      pos++;
    }

    pushCandidate(url, descriptors);
  }

  return parts.length > 0 ? parts.join(", ") : null;
};

const emitSanitizedAttributes = (
  name: string,
  attribs: Record<string, string>,
): string => {
  if (name === "a") {
    attribs["rel"] = "noopener noreferrer";
  }
  let out = "";
  for (const attr in attribs) {
    if (!Object.hasOwn(attribs, attr)) continue;
    let value = attribs[attr]!;
    if (value === "") {
      if (attr === "alt") {
        out += ' alt=""';
      } else if (attr === "controls") {
        out += " controls";
      }
      continue;
    }
    if (urlAttributes.has(attr) && isNaughtyHref(value)) {
      continue;
    }
    if (attr === "srcset") {
      const cleanSrcset = sanitizeSrcset(value);
      if (cleanSrcset === null) continue;
      value = cleanSrcset;
    }
    out += ` ${attr}="${escapeAttr(value)}"`;
  }
  return out;
};

class HtmlSanitizer {
  private readonly tokenizer: Tokenizer;
  private input = "";
  private result = "";
  private iframeFallbackDepth = 0;
  private openStack: string[] = [];
  private foreignContext: number[] = [foreignNone];
  private sanitizeStack: string[] = [];
  private skipStack: boolean[] = [];
  private skipText = false;
  private skipTextDepth = 0;
  private tagName = "";
  private allowedAttrsForTag: ReadonlySet<string> | undefined;
  private attribs: Record<string, string> | null = null;
  private seenAttrs: Set<string> | null = null;
  private currentAttrName = "";
  private currentAttrValue = "";
  private collectAttr = false;

  constructor() {
    this.tokenizer = new Tokenizer({ decodeEntities: true }, this);
  }

  public sanitize(html: string, iframeFallbackDepth: number): string {
    this.input = html;
    this.result = "";
    this.iframeFallbackDepth = iframeFallbackDepth;
    this.openStack.length = 0;
    this.foreignContext.length = 1;
    this.foreignContext[0] = foreignNone;
    this.sanitizeStack.length = 0;
    this.skipStack.length = 0;
    this.skipText = false;
    this.skipTextDepth = 0;
    this.tagName = "";
    this.allowedAttrsForTag = undefined;
    this.attribs = null;
    this.seenAttrs = null;
    this.currentAttrName = "";
    this.currentAttrValue = "";
    this.collectAttr = false;
    this.tokenizer.reset();
    this.tokenizer.write(html);
    this.tokenizer.end();
    const output = this.result;
    this.input = "";
    this.result = "";
    return output;
  }

  public isInForeignContext(): boolean {
    return this.foreignContext[this.foreignContext.length - 1] !== foreignNone;
  }

  public ontext(start: number, endIndex: number): void {
    if (this.skipText) return;
    const text = this.input.slice(start, endIndex);
    const currentTag = this.sanitizeStack[this.sanitizeStack.length - 1];
    if (
      currentTag === "iframe" &&
      this.iframeFallbackDepth < maxIframeFallbackDepth
    ) {
      this.result += sanitizeHtmlInput(text, this.iframeFallbackDepth + 1);
      return;
    }
    this.result += escapeText(text);
  }

  public ontextentity(codepoint: number): void {
    if (this.skipText) return;
    const currentTag = this.sanitizeStack[this.sanitizeStack.length - 1];
    if (
      currentTag === "iframe" &&
      this.iframeFallbackDepth < maxIframeFallbackDepth
    ) {
      this.result += sanitizeHtmlInput(
        String.fromCodePoint(codepoint),
        this.iframeFallbackDepth + 1,
      );
      return;
    }
    if (codepoint === 38) this.result += "&amp;";
    else if (codepoint === 60) this.result += "&lt;";
    else if (codepoint === 62) this.result += "&gt;";
    else this.result += String.fromCodePoint(codepoint);
  }

  public onopentagname(start: number, endIndex: number): void {
    this.emitOpenTag(this.readTagName(start, endIndex));
  }

  public onattribname(start: number, endIndex: number): void {
    if (this.allowedAttrsForTag === undefined) return;
    const raw = this.input.slice(start, endIndex);
    const name = raw.toLowerCase();
    if (this.allowedAttrsForTag.has(name)) {
      this.currentAttrName = name;
      this.currentAttrValue = "";
      this.collectAttr = true;
    } else {
      this.collectAttr = false;
    }
  }

  public onattribdata(start: number, endIndex: number): void {
    if (!this.collectAttr) return;
    this.currentAttrValue += this.input.slice(start, endIndex);
  }

  public onattribentity(codepoint: number): void {
    if (!this.collectAttr) return;
    this.currentAttrValue += String.fromCodePoint(codepoint);
  }

  public onattribend(): void {
    if (!this.collectAttr) return;
    this.collectAttr = false;
    const name = this.currentAttrName;
    if (this.seenAttrs !== null && !this.seenAttrs.has(name)) {
      this.seenAttrs.add(name);
      if (this.attribs !== null) {
        this.attribs[name] = this.currentAttrValue;
      }
    }
    this.currentAttrValue = "";
  }

  public onopentagend(): void {
    this.endOpenTag();
  }

  public onselfclosingtag(): void {
    if (this.isInForeignContext()) {
      const name = this.tagName;
      this.endOpenTag();
      if (this.openStack[this.openStack.length - 1] === name) {
        this.popElement();
      }
    } else {
      this.endOpenTag();
    }
  }

  public onclosetag(start: number, endIndex: number): void {
    const name = this.readTagName(start, endIndex);
    if (!voidElements.has(name)) {
      const pos = this.openStack.lastIndexOf(name);
      if (pos !== -1) {
        while (this.openStack.length - 1 > pos) {
          this.popElement();
        }
        this.popElement();
      } else if (name === "p") {
        this.emitOpenTag("p");
        this.endOpenTag();
        if (this.openStack[this.openStack.length - 1] === "p") {
          this.popElement();
        }
      }
    } else if (name === "br") {
      this.handleOpenTag("br", null);
      this.handleCloseTag("br");
    }
  }

  public oncdata(start: number, endIndex: number, offset: number): void {
    if (this.isInForeignContext()) {
      this.ontext(start, endIndex - offset);
    }
  }

  public oncomment(): void {}

  public ondeclaration(): void {}

  public onprocessinginstruction(): void {}

  public onend(): void {
    for (let i = this.openStack.length - 1; i >= 0; i--) {
      this.handleCloseTag(this.openStack[i]!);
    }
    this.openStack.length = 0;
  }

  private readTagName(start: number, endIndex: number): string {
    const name = this.input.slice(start, endIndex).toLowerCase();
    const topForeign = this.foreignContext[this.foreignContext.length - 1];
    if (topForeign === foreignSvg) {
      return svgTagNameAdjustments.get(name) ?? name;
    }
    if (this.foreignContext.length > 1) {
      const adjusted = svgTagNameAdjustments.get(name);
      if (adjusted !== undefined && this.openStack.includes(adjusted)) {
        return adjusted;
      }
    }
    if (topForeign === foreignNone) {
      return name === "image" ? "img" : name;
    }
    return name;
  }

  private emitOpenTag(name: string): void {
    this.tagName = name;
    this.allowedAttrsForTag = undefined;
    this.attribs = null;
    this.seenAttrs = null;
    this.collectAttr = false;

    if (name === "form" && this.openStack.includes("form")) {
      this.tagName = "";
      return;
    }
    const impliesClose = openImpliesClose.get(name);
    if (impliesClose !== undefined) {
      while (
        this.openStack.length > 0 &&
        impliesClose.has(this.openStack[this.openStack.length - 1]!)
      ) {
        this.popElement();
      }
    }
    if (!voidElements.has(name)) {
      this.openStack.push(name);
      if (name === "svg") {
        this.foreignContext.push(foreignSvg);
      } else if (name === "math") {
        this.foreignContext.push(foreignMathMl);
      } else if (htmlIntegrationElements.has(name)) {
        this.foreignContext.push(foreignNone);
      }
    }
    if (!this.skipText) {
      const allowed = allowedAttributesByTag[name];
      if (allowed !== undefined) {
        this.allowedAttrsForTag = allowed;
        this.attribs =
          name === "img" ? { decoding: "async", loading: "lazy" } : {};
        this.seenAttrs = new Set();
      }
    }
  }

  private endOpenTag(): void {
    const name = this.tagName;
    if (name !== "") {
      const attribs = this.attribs;
      this.attribs = null;
      this.seenAttrs = null;
      this.allowedAttrsForTag = undefined;
      this.handleOpenTag(name, attribs);
      if (voidElements.has(name)) {
        this.handleCloseTag(name);
      }
      this.tagName = "";
    }
  }

  private popElement(): void {
    const element = this.openStack.pop();
    if (element === undefined) return;
    if (
      foreignContextElements.has(element) ||
      htmlIntegrationElements.has(element)
    ) {
      this.foreignContext.pop();
    }
    this.handleCloseTag(element);
  }

  private handleOpenTag(
    name: string,
    attribs: Record<string, string> | null,
  ): void {
    if (this.skipText) {
      this.skipTextDepth++;
      return;
    }
    this.sanitizeStack.push(name);
    if (!allowedTags.has(name)) {
      this.skipStack.push(true);
      if (nonTextTags.has(name)) {
        this.skipText = true;
        this.skipTextDepth = 1;
      }
      return;
    }
    this.skipStack.push(false);
    let out = `<${name}`;
    if (attribs !== null) {
      out += emitSanitizedAttributes(name, attribs);
    }
    out += selfClosingTags.has(name) ? " />" : ">";
    this.result += out;
  }

  private handleCloseTag(name: string): void {
    if (this.skipText) {
      this.skipTextDepth--;
      if (this.skipTextDepth > 0) return;
      this.skipText = false;
    }
    const top = this.sanitizeStack.pop();
    if (top === undefined) return;
    if (top !== name) {
      this.sanitizeStack.push(top);
      return;
    }
    this.skipText = false;
    const skipped = this.skipStack.pop();
    if (skipped || selfClosingTags.has(name)) return;
    this.result += `</${name}>`;
  }
}

const isHtmlWhitespace = (code: number): boolean =>
  code === 32 || code === 10 || code === 9 || code === 12 || code === 13;

const isAsciiAlpha = (code: number): boolean =>
  (code >= 97 && code <= 122) || (code >= 65 && code <= 90);

const isTagSectionEnd = (code: number): boolean =>
  code === 62 || code === 47 || isHtmlWhitespace(code);

const adjustTagName = (
  rawLower: string,
  foreignContext: readonly number[],
  openStack: readonly string[],
): string => {
  const topForeign = foreignContext[foreignContext.length - 1];
  if (topForeign === foreignSvg) {
    return svgTagNameAdjustments.get(rawLower) ?? rawLower;
  }
  if (foreignContext.length > 1) {
    const adjusted = svgTagNameAdjustments.get(rawLower);
    if (adjusted !== undefined && openStack.includes(adjusted)) {
      return adjusted;
    }
  }
  if (topForeign === foreignNone) {
    return rawLower === "image" ? "img" : rawLower;
  }
  return rawLower;
};

type ScannedTagAttributes = {
  selfClosingSlash: boolean;
  tagEnd: number;
};

const scanTagAttributes = (
  html: string,
  startPos: number,
  name: string,
  allowedAttrs: ReadonlySet<string> | undefined,
  attribs: Record<string, string> | null,
): ScannedTagAttributes | null => {
  const len = html.length;
  let p = startPos;
  const chAtP = html.charCodeAt(p);
  if (chAtP === 62) {
    return { selfClosingSlash: false, tagEnd: p };
  }
  if (chAtP === 47 && p + 1 < len && html.charCodeAt(p + 1) === 62) {
    return { selfClosingSlash: true, tagEnd: p + 1 };
  }

  let seenDecoding = false;
  let seenLoading = false;
  let lastSlash = false;

  while (p < len) {
    const c = html.charCodeAt(p);
    if (c === 62) {
      return { selfClosingSlash: lastSlash, tagEnd: p };
    }
    if (c === 47) {
      lastSlash = true;
      p++;
      continue;
    }
    if (isHtmlWhitespace(c)) {
      p++;
      continue;
    }
    lastSlash = false;

    const attrStart = p;
    p++;
    while (p < len) {
      const ac = html.charCodeAt(p);
      if (ac === 61 || isTagSectionEnd(ac)) break;
      p++;
    }
    if (p >= len) return null;

    const attrEnd = p;
    while (p < len && isHtmlWhitespace(html.charCodeAt(p))) p++;
    if (p >= len) return null;

    let valStart = -1;
    let valEnd = -1;
    if (html.charCodeAt(p) === 61) {
      p++;
      while (p < len && isHtmlWhitespace(html.charCodeAt(p))) p++;
      if (p >= len) return null;
      const qc = html.charCodeAt(p);
      if (qc === 34) {
        valStart = p + 1;
        const close = html.indexOf('"', valStart);
        if (close === -1) return null;
        valEnd = close;
        p = close + 1;
      } else if (qc === 39) {
        valStart = p + 1;
        const close = html.indexOf("'", valStart);
        if (close === -1) return null;
        valEnd = close;
        p = close + 1;
      } else {
        valStart = p;
        while (p < len) {
          const vc = html.charCodeAt(p);
          if (vc === 62 || isHtmlWhitespace(vc)) break;
          p++;
        }
        if (p >= len) return null;
        valEnd = p;
      }
    }

    if (allowedAttrs === undefined || attribs === null) continue;
    const attrName = html.slice(attrStart, attrEnd).toLowerCase();
    if (!allowedAttrs.has(attrName)) continue;

    let duplicate = false;
    if (name === "img" && attrName === "decoding") {
      duplicate = seenDecoding;
      seenDecoding = true;
    } else if (name === "img" && attrName === "loading") {
      duplicate = seenLoading;
      seenLoading = true;
    } else {
      duplicate = Object.hasOwn(attribs, attrName);
    }
    if (duplicate) continue;

    if (valStart === -1 || valStart === valEnd) {
      attribs[attrName] = "";
    } else {
      const rawVal = html.slice(valStart, valEnd);
      attribs[attrName] = rawVal.includes("&")
        ? decodeHTMLAttribute(rawVal)
        : rawVal;
    }
  }

  return null;
};

const fastSanitize = (
  html: string,
  iframeFallbackDepth: number,
): string | null => {
  const len = html.length;
  let pos = 0;
  let copyStart = 0;
  let out = "";
  let nextAmp = html.indexOf("&");
  let nextGt = html.indexOf(">");
  const openStack: string[] = [];
  const skipStack: boolean[] = [];
  const foreignContext: number[] = [foreignNone];
  let skipTextDepth = 0;

  const flushUpTo = (end: number) => {
    if (copyStart !== -1 && end > copyStart) {
      out += html.slice(copyStart, end);
    }
    copyStart = -1;
  };

  const handleTextSpan = (start: number, end: number) => {
    if (start >= end) return;
    if (skipTextDepth > 0) {
      flushUpTo(start);
      return;
    }
    if (nextAmp !== -1 && nextAmp < start) {
      nextAmp = html.indexOf("&", start);
    }
    const hasAmp = nextAmp !== -1 && nextAmp < end;
    if (hasAmp) {
      flushUpTo(start);
      out += escapeText(decodeHTML(html.slice(start, end)));
      return;
    }
    if (nextGt !== -1 && nextGt < start) {
      nextGt = html.indexOf(">", start);
    }
    if (nextGt !== -1 && nextGt < end) {
      flushUpTo(start);
      out += html.slice(start, end).replaceAll(">", "&gt;");
      return;
    }
    if (copyStart === -1) copyStart = start;
  };

  const popOne = () => {
    const popped = openStack.pop()!;
    const flags = tagFlags.get(popped) ?? 0;
    if ((flags & flagForeignChange) !== 0) {
      foreignContext.pop();
    }
    if (skipTextDepth > 0) {
      skipTextDepth--;
      if (skipTextDepth > 0) return;
    }
    const skipped = skipStack.pop();
    if (!skipped && (flags & flagSelfClosing) === 0) {
      out += `</${popped}>`;
    }
  };

  while (pos < len) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      handleTextSpan(pos, len);
      break;
    }

    if (lt > pos) {
      handleTextSpan(pos, lt);
    }

    if (lt + 1 >= len) {
      flushUpTo(lt);
      if (skipTextDepth === 0) out += "&lt;";
      break;
    }

    const next = html.charCodeAt(lt + 1);

    if (next === 47) {
      if (lt + 2 >= len) return null;
      const c2 = html.charCodeAt(lt + 2);
      if (c2 === 62) {
        flushUpTo(lt);
        pos = lt + 3;
        continue;
      }
      if (!isAsciiAlpha(c2)) {
        flushUpTo(lt);
        const gt = html.indexOf(">", lt + 2);
        if (gt === -1) {
          pos = len;
          break;
        }
        pos = gt + 1;
        continue;
      }
      let hasUpper = c2 < 97;
      let p = lt + 3;
      while (p < len) {
        const ch = html.charCodeAt(p);
        if (isTagSectionEnd(ch)) break;
        if (ch >= 65 && ch <= 90) hasUpper = true;
        p++;
      }
      const exactClose = p < len && html.charCodeAt(p) === 62;
      const gt = exactClose ? p : html.indexOf(">", p);
      if (gt === -1) return null;
      const rawLower = hasUpper
        ? html.slice(lt + 2, p).toLowerCase()
        : html.slice(lt + 2, p);
      const name =
        foreignContext.length === 1
          ? rawLower === "image"
            ? "img"
            : rawLower
          : adjustTagName(rawLower, foreignContext, openStack);
      const flags = tagFlags.get(name) ?? 0;
      if ((flags & flagFallback) !== 0) return null;

      if (
        exactClose &&
        !hasUpper &&
        skipTextDepth === 0 &&
        (flags & (flagVoid | flagSelfClosing | flagForeignChange)) === 0 &&
        openStack.length > 0 &&
        openStack[openStack.length - 1] === name &&
        !skipStack[skipStack.length - 1]
      ) {
        openStack.pop();
        skipStack.pop();
        if (copyStart === -1) copyStart = lt;
        pos = gt + 1;
        continue;
      }

      flushUpTo(lt);
      if ((flags & flagVoid) === 0) {
        const idx = openStack.lastIndexOf(name);
        if (idx !== -1) {
          while (openStack.length > idx) {
            popOne();
          }
        } else if (name === "p" && skipTextDepth === 0) {
          out += "<p></p>";
        }
      } else if (name === "br" && skipTextDepth === 0) {
        out += "<br />";
      }
      pos = gt + 1;
      continue;
    }

    if (next === 33) {
      flushUpTo(lt);
      if (
        lt + 3 < len &&
        html.charCodeAt(lt + 2) === 45 &&
        html.charCodeAt(lt + 3) === 45
      ) {
        const afterStart = html.charCodeAt(lt + 4);
        if (
          afterStart === 62 ||
          (afterStart === 45 && html.charCodeAt(lt + 5) === 62)
        ) {
          return null;
        }
        const end = html.indexOf("-->", lt + 4);
        if (end === -1) return null;
        const altEnd = html.indexOf("--!>", lt + 4);
        if (altEnd !== -1 && altEnd < end) return null;
        pos = end + 3;
        continue;
      }
      if (html.charCodeAt(lt + 2) === 91) return null;
      const gt = html.indexOf(">", lt + 2);
      if (gt === -1) {
        pos = len;
        break;
      }
      pos = gt + 1;
      continue;
    }

    if (next === 63) {
      flushUpTo(lt);
      const gt = html.indexOf(">", lt + 2);
      if (gt === -1) {
        pos = len;
        break;
      }
      pos = gt + 1;
      continue;
    }

    if (!isAsciiAlpha(next)) {
      flushUpTo(lt);
      if (skipTextDepth === 0) out += "&lt;";
      pos = lt + 1;
      continue;
    }

    let hasUpper = next < 97;
    let p = lt + 2;
    while (p < len) {
      const ch = html.charCodeAt(p);
      if (isTagSectionEnd(ch)) break;
      if (ch >= 65 && ch <= 90) hasUpper = true;
      p++;
    }
    if (p >= len) return null;

    const rawLower = hasUpper
      ? html.slice(lt + 1, p).toLowerCase()
      : html.slice(lt + 1, p);
    const inForeign = foreignContext[foreignContext.length - 1] !== foreignNone;
    const name =
      foreignContext.length === 1
        ? rawLower === "image"
          ? "img"
          : rawLower
        : adjustTagName(rawLower, foreignContext, openStack);
    const flags = tagFlags.get(name) ?? 0;
    if ((flags & flagFallback) !== 0) return null;

    const chAtP = html.charCodeAt(p);
    if (
      chAtP === 62 &&
      !hasUpper &&
      skipTextDepth === 0 &&
      (flags &
        (flagAllowed |
          flagVoid |
          flagSelfClosing |
          flagHasAttrs |
          flagRawText |
          flagForeignChange)) ===
        flagAllowed
    ) {
      let closedAny = false;
      if ((flags & flagImpliesClose) !== 0) {
        const implies = openImpliesClose.get(name)!;
        while (
          openStack.length > 0 &&
          implies.has(openStack[openStack.length - 1]!)
        ) {
          if (!closedAny) {
            flushUpTo(lt);
            closedAny = true;
          }
          popOne();
        }
      }
      openStack.push(name);
      skipStack.push(false);
      if (copyStart === -1) copyStart = lt;
      pos = p + 1;
      continue;
    }

    flushUpTo(lt);

    const isDuplicateForm = name === "form" && openStack.includes("form");
    const wantAttrs =
      !isDuplicateForm && skipTextDepth === 0 && (flags & flagHasAttrs) !== 0;
    const allowedAttrs = wantAttrs ? allowedAttributesByTag[name] : undefined;
    const attribs: Record<string, string> | null =
      allowedAttrs !== undefined
        ? name === "img"
          ? { decoding: "async", loading: "lazy" }
          : {}
        : null;

    const scanned = scanTagAttributes(html, p, name, allowedAttrs, attribs);
    if (scanned === null) return null;
    const { selfClosingSlash, tagEnd } = scanned;

    if (isDuplicateForm) {
      pos = tagEnd + 1;
      continue;
    }

    if ((flags & flagImpliesClose) !== 0) {
      const implies = openImpliesClose.get(name)!;
      while (
        openStack.length > 0 &&
        implies.has(openStack[openStack.length - 1]!)
      ) {
        popOne();
      }
    }

    if (!inForeign && (flags & flagRawText) !== 0) {
      const rawPattern = rawTextClosePatterns[name]!;
      rawPattern.lastIndex = tagEnd + 1;
      const match = rawPattern.exec(html);
      const bodyEnd = match ? match.index : len;
      if (skipTextDepth === 0) {
        if (name === "iframe") {
          const rawBody = html.slice(tagEnd + 1, bodyEnd);
          if (rawBody) {
            out +=
              iframeFallbackDepth < maxIframeFallbackDepth
                ? sanitizeHtmlInput(rawBody, iframeFallbackDepth + 1)
                : escapeText(rawBody);
          }
        } else if (name === "title") {
          const rawTitle = html.slice(tagEnd + 1, bodyEnd);
          if (rawTitle) {
            out += rawTitle.includes("&")
              ? escapeText(decodeHTML(rawTitle))
              : escapeText(rawTitle);
          }
        }
      }
      if (!match) {
        pos = len;
        break;
      }
      const closeGt =
        html.charCodeAt(match.index + match[0].length - 1) === 62
          ? match.index + match[0].length - 1
          : html.indexOf(">", match.index + match[0].length);
      if (closeGt === -1) {
        pos = len;
        break;
      }
      pos = closeGt + 1;
      continue;
    }

    const isAllowed = (flags & flagAllowed) !== 0;
    const isVoid = (flags & flagVoid) !== 0;
    const entersForeign = name === "svg" || name === "math";
    const selfClosedForeign =
      selfClosingSlash &&
      (inForeign || entersForeign) &&
      !htmlIntegrationElements.has(name);

    if (!isVoid && !selfClosedForeign) {
      openStack.push(name);
      if ((flags & flagForeignChange) !== 0) {
        if (name === "svg") foreignContext.push(foreignSvg);
        else if (name === "math") foreignContext.push(foreignMathMl);
        else foreignContext.push(foreignNone);
      }
      if (skipTextDepth > 0) {
        skipTextDepth++;
      } else {
        skipStack.push(!isAllowed);
        if (!isAllowed && (flags & flagNonText) !== 0) {
          skipTextDepth = 1;
        }
      }
    }

    if (skipTextDepth === 0 && isAllowed) {
      out += `<${name}`;
      if (attribs !== null) {
        out += emitSanitizedAttributes(name, attribs);
      }
      if ((flags & flagSelfClosing) !== 0) {
        out += " />";
      } else {
        out += ">";
        if (isVoid || selfClosedForeign) out += `</${name}>`;
      }
    }

    pos = tagEnd + 1;
  }

  if (copyStart === 0 && out === "" && openStack.length === 0) {
    return html;
  }
  flushUpTo(len);
  while (openStack.length > 0) {
    popOne();
  }
  return out;
};

const sanitizerPool: HtmlSanitizer[] = [];

const sanitizeHtmlInput = (
  html: string,
  iframeFallbackDepth: number,
): string => {
  if (!html) return "";
  if (!html.includes("<")) {
    if (!html.includes("&")) {
      return html.includes(">") ? html.replaceAll(">", "&gt;") : html;
    }
    return escapeText(decodeHTML(html));
  }
  const fast = fastSanitize(html, iframeFallbackDepth);
  if (fast !== null) return fast;
  let sanitizer = sanitizerPool[iframeFallbackDepth];
  if (sanitizer === undefined) {
    sanitizer = new HtmlSanitizer();
    sanitizerPool[iframeFallbackDepth] = sanitizer;
  }
  return sanitizer.sanitize(html, iframeFallbackDepth);
};

export const sanitizerVersion = 1;

export const extractArticle = (content: null | string | undefined): string =>
  content ? sanitizeHtmlInput(content, 0) : "";
