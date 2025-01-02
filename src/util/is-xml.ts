export function isXml(text: string) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, "text/xml");
  return xmlDoc.getElementsByTagName("parsererror").length === 0;
}
