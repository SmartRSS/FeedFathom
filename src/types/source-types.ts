import type * as schema from "../db/schemas/sources";

export enum NodeType {
  Folder = "folder",
  Source = "source",
}

export type Source = typeof schema.sources.$inferSelect;

export type TreeNode = TreeFolder | TreeSource;
export type TreeSource = {
  favicon: null | string;
  homeUrl: string;
  name: string;
  type: NodeType.Source;
  uid: string;
  unreadCount: number;
  xmlUrl: string;
};
type TreeFolder = {
  children: TreeNode[];
  name: string;
  type: NodeType.Folder;
  uid: string;
};
