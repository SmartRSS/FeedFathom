import type * as schema from "$lib/schema";

export enum NodeType {
  FOLDER = "folder",
  SOURCE = "source",
}

export type Source = typeof schema.sources.$inferSelect;

export type TreeNode = TreeFolder | TreeSource;
export type TreeSource = {
  favicon: null | string;
  homeUrl: string;
  name: string;
  type: NodeType.SOURCE;
  uid: string;
  unreadCount: number;
  xmlUrl: string;
};
type TreeFolder = {
  children: TreeNode[];
  name: string;
  type: NodeType.FOLDER;
  uid: string;
};
