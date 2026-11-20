const TEXT = "#text";
const ATTRS = ":@";

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
