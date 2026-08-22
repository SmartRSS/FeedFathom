export type OpmlFolder = {
  children: Array<OpmlFolder | OpmlSource>;
  name: string;
  type: "folder";
};
export type OpmlNode = OpmlFolder | OpmlSource;
export type OpmlSource = {
  homeUrl: string;
  name: string;
  type: "source";
  xmlUrl: string;
};
/**
 * A parsed <outline> element. Bun's XML parser puts attributes on the element
 * itself under an "@" prefix, and collapses a lone child to a single object.
 */
export type Outline = {
  [key: string]: unknown;
  outline?: Outline | Outline[];
};
