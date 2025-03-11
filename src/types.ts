import type { DisplayMode } from "$lib/settings";
import type { Article } from "./types/article-type.ts";
import type { TreeNode } from "./types/source-types.ts";

export type ArticleListComponentProps = {
  articlesLoaded: ArticlesLoadedFunction;
  articlesRemoved: ArticlesRemovedFunction;
  articlesSelected: ArticlesSelectedFunction;
  focusChanged: FocusChangedFunction;
  focusedColumn: FocusTarget;
  promisesMap: ArticlePromisesMap;
  selectedSourcesList: string[];
};

export type ArticlePromisesMap = Map<
  string,
  { promise: Promise<Article[]>; time: number }
>;

export type ArticlesLoadedFunction = (
  sourcesArticlesMap: Map<string, number>,
) => void;

export type ArticlesRemovedFunction = (
  removedArticleList: Article[],
) => Promise<void>;

export type ArticlesSelectedFunction = (
  selectedArticleIdList: number[],
) => void;

export type DisplayModeChangedFunction = (displayMode: DisplayMode) => void;

export type FeedData = {
  title: string;
  url: string;
};

export type FocusChangedFunction = (focusTarget: FocusTarget) => void;

export type FocusTarget =
  | ".articles-column"
  | ".content-column"
  | ".sources-column";

export type NodeEventFunction = (node: TreeNode) => void;

export type TreeNodeComponentProps = {
  nested: boolean;
  node: TreeNode;
  nodeHeld: NodeEventFunction;
  nodeMouseLeave: NodeEventFunction;
  nodeSelected: NodeEventFunction;
  nodeTouchEnd: NodeEventFunction;
  nodeTouchStart: NodeEventFunction;
  selectedNodeUid: string;
};
