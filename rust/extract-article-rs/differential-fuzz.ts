import { createRequire } from "node:module";
import { extractArticle as jsExtract } from "../../src/features/feeds/extract-article.ts";

const rust = createRequire(import.meta.url)(
  process.env["RUST_MODULE"] ?? `${import.meta.dir}/index.cjs`,
).extractArticle;
const run = process.env.IMPL === "rust" ? rust : jsExtract;
const count = Number(process.env.COUNT ?? 100_000);
let seed = Number(process.env.SEED ?? 1);
const rnd = (n: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed % n;
};
const pick = <T>(items: readonly T[]): T => items[rnd(items.length)]!;
const chance = (percent: number) => rnd(100) < percent;

const tagNames = [
  "a", "img", "p", "div", "span", "b", "i", "em", "strong", "br", "hr", "ul", "ol", "li", "dl", "dd", "dt",
  "table", "tr", "td", "th", "tbody", "thead", "tfoot", "caption", "col", "colgroup", "h1", "h2", "h3", "h6",
  "pre", "code", "blockquote", "figure", "figcaption", "picture", "source", "audio", "video", "track",
  "script", "style", "iframe", "textarea", "title", "xmp", "option", "optgroup", "select", "noembed",
  "noframes", "plaintext", "noscript", "svg", "math", "foreignObject", "foreignobject", "clipPath", "desc",
  "mi", "mtext", "annotation-xml", "image", "form", "input", "button", "datalist", "output", "body", "head",
  "html", "link", "meta", "base", "rt", "rp", "ruby", "wbr", "time", "data", "abbr", "sub", "sup", "q", "s",
  "u", "mark", "kbd", "samp", "var", "small", "cite", "dfn", "bdi", "bdo", "section", "article", "aside",
  "nav", "main", "header", "footer", "address", "menu", "details", "fieldset", "animate", "set", "x-custom",
];
const attrNames = [
  "href", "src", "srcset", "alt", "title", "rel", "target", "name", "decoding", "loading", "controls", "poster",
  "width", "height", "sizes", "type", "class", "style", "onclick", "onerror", "id", "data-x", "xlink:href",
  "attributename", "values", "__proto__", "constructor", "toString", "0", "1", "lang", "dir", "<x", "a\"b",
];
const schemes = ["http://", "https://", "javascript:", "JaVaScRiPt:", "data:", "mailto:", "ftp://", "tel:", "vbscript:", "//", "\\\\", "", "/", "#", "?q="];
const words = ["a", "b", "img.png", "x y", "path/to", "é", "😀", "Σ", "İ", "K", " ", "1", "0", "-", ".", ","];
const entities = [
  "&amp;", "&amp", "&AMP;", "&lt;", "&lt", "&gt", "&quot", "&nbsp;", "&nbsp", "&copy", "&not", "&notin;",
  "&notit;", "&hellip;", "&hellip", "&nvlt;", "&bne;", "&Aacute", "&aacutex", "&ampx", "&amp=", "&;", "&zz;",
  "&#", "&#x", "&#;", "&#x;", "&#0;", "&#38;", "&#x26", "&#128;", "&#x80;", "&#150;", "&#xD800;", "&#x110000;",
  "&#99999999999;", "&#65", "&#x1F600;", "&CounterClockwiseContourIntegral;",
];
const oddChars = [
  "\u0000", "\u0001", "\u001c", "\u000f", "\t", "\n", "\r", "\f", " ", " ", "﻿", "\ud800",
  "\udfff", "\ud83d", "\ude00", "😀", "𝔸", "￿", "İ", "K", "ς", "Σ",
];
const markup = [
  "<!-- c -->", "<!---->", "<!-->", "<!--->", "<!-- a -- b --!>", "<!--", "<![CDATA[x<y>]]>", "<![CDATA[",
  "<!DOCTYPE html>", "<!doctypex>", "<!>", "<!-x>", "<?pi?>", "</>", "</ >", "< p>", "</br>", "</p>", "<",
  "<<", ">", "</", "&", "\u001c\u000fscript", "</SCRIPT >", "</style\t", "</iframe/", "</title>", "</xmp",
];

const text = (): string => {
  let out = "";
  const n = 1 + rnd(6);
  for (let i = 0; i < n; i++) {
    const r = rnd(10);
    out += r < 5 ? pick(words) : r < 7 ? pick(entities) : r < 9 ? pick(oddChars) : pick(["<", ">", "&", "\"", "'", "="]);
  }
  return out;
};
const srcset = (): string => {
  const n = 1 + rnd(4);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const url = pick(schemes) + pick(words).replace(/\s/g, "");
    const d = pick(["", " 1x", " 2x", " 1.5x", " 100w", " 0w", " -1x", " 1e2x", " 10h", " 99999999999999999999w", " (a b)", " 1x 2x", "x", " 2.x"]);
    parts.push(url + d);
  }
  return parts.join(pick([", ", ",", " , ", ",,", " "]));
};
const attrValue = (name: string): string => {
  if (name === "srcset" && chance(70)) return srcset();
  if (["href", "src", "poster", "xlink:href"].includes(name) && chance(70)) return pick(schemes) + text();
  return chance(20) ? "" : text();
};
const tag = (): string => {
  let name = pick(tagNames);
  if (chance(10)) name = name.toUpperCase();
  let out = "<" + name;
  const n = rnd(4);
  for (let i = 0; i < n; i++) {
    let attr = pick(attrNames);
    if (chance(10)) attr = attr.toUpperCase();
    const value = attrValue(attr.toLowerCase());
    const sep = pick([" ", "  ", "\n", "\t", "/", " /"]);
    const q = rnd(6);
    out += sep + attr + (q === 0 ? "" : q === 1 ? "=" + value.replace(/[\s>"']/g, "") : q <= 3 ? "=\"" + value.replace(/"/g, "") + "\"" : "='" + value.replace(/'/g, "") + "'");
  }
  return out + pick([">", ">", ">", ">", "/>", " />", " >", ""]);
};
const piece = (depth: number): string => {
  const r = rnd(20);
  if (r < 7) return text();
  if (r < 10) return pick(markup);
  if (r < 12 || depth > 6) return "</" + pick(tagNames) + pick([">", " x>", ""]);
  const open = tag();
  const name = open.slice(1).split(/[\s/>]/)[0]!;
  let inner = "";
  const n = rnd(4);
  for (let i = 0; i < n; i++) inner += piece(depth + 1);
  return open + inner + (chance(70) ? "</" + (chance(85) ? name : pick(tagNames)) + ">" : "");
};

for (let i = 0; i < count; i++) {
  let doc = "";
  const n = 1 + rnd(8);
  for (let k = 0; k < n; k++) doc += piece(0);
  if (chance(5)) doc = doc.slice(0, rnd(doc.length + 1));
  const out = run(doc);
  console.log(i, Bun.hash(Buffer.from(out, "utf16le")).toString(36), out.length);
}
