import * as schema from "$lib/schema";

export type Source = typeof schema.sources.$inferSelect;

export enum NodeType {
  FOLDER = "folder",
  SOURCE = "source",
}

type TreeFolder = {
  uid: string;
  type: NodeType.FOLDER;
  name: string;
  children: TreeNode[];
};
export type TreeSource = {
  uid: string;
  type: NodeType.SOURCE;
  xmlUrl: string;
  name: string;
  homeUrl: string;
  unreadCount: number;
  favicon: string | null;
};
export type TreeNode = TreeFolder | TreeSource;
