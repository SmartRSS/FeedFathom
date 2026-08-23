// Stands in for the real `fast-xml-parser` package (and its 6 transitive
// dependencies) wherever @rowanmanning/feed-parser imports from it, so all
// XML in this repo goes through Bun's native parser. Listed as a direct
// "fast-xml-parser": "file:./vendor/fast-xml-parser-shim" dependency in the
// root package.json -- feed-parser's nested `require("fast-xml-parser")`
// resolves here via normal node_modules parent-directory lookup, so
// `bun install` never fetches the real package at all. Same arrangement as
// vendor/linkedom-shim.
//
// feed-parser uses exactly two things: XMLParser in preserveOrder mode and
// XMLBuilder to re-serialise an element's children for `innerHtml`. Nothing
// else is implemented, deliberately -- if a future feed-parser reaches for
// XMLValidator or a different parser option, it should fail loudly here
// rather than silently behave differently.
//
// Our own code does not go through this shim; it calls Bun.XML via
// src/platform/xml.ts, which uses the simpler compact shape.

const TEXT = "#text";
const ATTRS = ":@";

// Bun's tree shape is {name, attributes, children} with children in document
// order; fast-xml-parser's preserveOrder shape keys each node by its tag name
// and hangs attributes off ":@". Comments and processing instructions have no
// equivalent (feed-parser sets no commentPropName, so the real parser drops
// them too) -- dropping them can leave two text runs adjacent, which the real
// parser would have emitted as one, so they get merged.
function convertChildren(children) {
  const converted = [];
  let text = null;
  const flushText = () => {
    if (text !== null) {
      converted.push({ [TEXT]: text });
      text = null;
    }
  };
  for (const child of children) {
    if (typeof child === "string") {
      text = text === null ? child : text + child;
      continue;
    }
    if (child.comment !== undefined || child.target !== undefined) continue;
    flushText();
    converted.push(convertNode(child));
  }
  flushText();
  return converted;
}

function convertNode(node) {
  const converted = { [node.name]: convertChildren(node.children) };
  if (Object.keys(node.attributes).length > 0) converted[ATTRS] = node.attributes;
  return converted;
}

class XMLParser {
  parse(xml) {
    return [convertNode(Bun.XML.parse(xml, { compact: false }))];
  }
}

// The real builder escapes all five predefined entities in both text and
// attribute values, and never self-closes: an empty element is "<p></p>".
const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

class XMLBuilder {
  build(nodes) {
    if (!Array.isArray(nodes)) return "";
    let xml = "";
    for (const node of nodes) {
      if (node[TEXT] !== undefined) {
        xml += escapeXml(node[TEXT]);
        continue;
      }
      // A node's tag name is its only key that isn't ":@" or "#text", which
      // is how feed-parser itself reads the name back out.
      const name = Object.keys(node).find((key) => key !== ATTRS && key !== TEXT);
      if (name === undefined) continue;
      let attributes = "";
      for (const [key, value] of Object.entries(node[ATTRS] ?? {}))
        attributes += ` ${key}="${escapeXml(value)}"`;
      xml += `<${name}${attributes}>${this.build(node[name])}</${name}>`;
    }
    return xml;
  }
}

exports.XMLParser = XMLParser;
exports.XMLBuilder = XMLBuilder;
