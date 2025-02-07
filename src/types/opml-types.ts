export type Outline = {
  [key: string]: unknown;
  $: {
    [key: string]: string;
  };
  outline?: Outline[];
};
export type OpmlSource = {
  type: "source";
  xmlUrl: string;
  name: string;
  homeUrl: string;
};
export type OpmlFolder = {
  type: "folder";
  name: string;
  children: (OpmlSource | OpmlFolder)[];
};
export type OpmlNode = OpmlFolder | OpmlSource;
