const fragmentView = (document, source) => {
  if (/^\s*(?:<!doctype|<html)/i.test(source)) return document;
  const root = document.body.firstElementChild;
  if (!root || document.body.children.length !== 1) return document;
  return new Proxy(document, {
    get(target, key) {
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
