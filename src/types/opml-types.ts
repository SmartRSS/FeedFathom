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
export type Outline = {
  $: {
    [key: string]: string;
  };
  [key: string]: unknown;
  outline?: Outline[];
};
