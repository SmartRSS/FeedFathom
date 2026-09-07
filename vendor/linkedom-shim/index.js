// Stands in for the real `linkedom` package (~910KB unpacked pure-JS DOM
// implementation) wherever @extractus/article-extractor imports { DOMParser }
// from it. Every DOM call article-extractor makes against the parsed
// document is a standard API (querySelector, getElementsByTagName,
// innerHTML, createElement, ...) -- nothing linkedom-specific -- so the
// browser's own native DOMParser is a drop-in replacement, and this repo
// only ever runs that code in a browser (see src/spa/extension-reader.ts).
// Wired in the same way as vendor/fast-xml-parser-shim: a direct
// "linkedom": "file:./vendor/linkedom-shim" dependency AND a matching
// "overrides" entry. The direct dependency alone is not enough. It was tried,
// on the theory that article-extractor's `import "linkedom"` would resolve
// upward to it, and it held only while a patchfile removed linkedom from
// article-extractor's own dependencies -- until that patch's version key went
// stale on a 9.0.0 -> 9.0.1 bump and stopped applying, at which point bun
// installed the real 2.6 MB package nested under article-extractor and the
// SPA bundle silently grew by 189 KB. The override does the same job without
// a version to keep in step, so the patchfile is gone.
//
// vendor/__tests__/shim-fidelity.test.ts is what notices if this comes undone
// again, or if a bump reaches for an export this file does not have.
// One place the browser is not a drop-in. Handed a fragment, linkedom makes
// the fragment's own root the documentElement; the browser always builds a
// whole document, so documentElement is <html> and its children are <head>
// and <body>. article-extractor 9.0.1 replaced its sanitize-html pass with a
// hand-rolled walk over `doc.documentElement.childNodes`, which under the
// native parser deletes head and body -- neither is an allowed tag -- and
// returns an empty string, so every extraction comes back null.
//
// So the fragment case gets a view of the document whose documentElement is
// the fragment root, and everything else is the native document untouched.
const fragmentView = (document, source) => {
  if (/^\s*(?:<!doctype|<html)/i.test(source)) return document;
  const root = document.body.firstElementChild;
  if (!root || document.body.children.length !== 1) return document;
  return new Proxy(document, {
    get(target, key) {
      // documentElement for the walk in cleanify, childNodes for the
      // serialize-back in execPre/PostParser -- article-extractor rounds a
      // fragment through both, and the synthesized <html> wrapper leaks into
      // the output of the second and eats the whole of the first.
      if (key === "documentElement") return root;
      if (key === "childNodes") return [root];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

export class DOMParser {
  parseFromString(source, type) {
    return fragmentView(
      new globalThis.DOMParser().parseFromString(source, type),
      source,
    );
  }
}
