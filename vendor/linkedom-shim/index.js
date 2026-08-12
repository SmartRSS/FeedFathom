// Stands in for the real `linkedom` package (~910KB unpacked pure-JS DOM
// implementation) wherever @extractus/article-extractor imports { DOMParser }
// from it. Every DOM call article-extractor makes against the parsed
// document is a standard API (querySelector, getElementsByTagName,
// innerHTML, createElement, ...) -- nothing linkedom-specific -- so the
// browser's own native DOMParser is a drop-in replacement, and this repo
// only ever runs that code in a browser (see src/spa/extension-reader.ts).
// Listed as a direct "linkedom": "file:./vendor/linkedom-shim" dependency
// in the root package.json (bun's "overrides" + file: combo didn't actually
// materialize into node_modules in the canary version this repo pins) --
// article-extractor's nested `import "linkedom"` resolves here via normal
// node_modules parent-directory lookup, so `bun install` never fetches the
// real linkedom package at all.
export const DOMParser = globalThis.DOMParser;
