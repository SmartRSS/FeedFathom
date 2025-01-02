import type { Article } from "./types/article.type";
import type { TreeNode } from "./types/source-types";
import type { DisplayMode } from "$lib/settings";

export interface FeedData {
  url: string;
  title: string;
}

export type ArticlePromisesMap = Map<
  string,
  { time: number; promise: Promise<Article[]> }
>;

export type ArticlesSelectedFunction = (
  selectedArticleIdList: number[],
) => Promise<void>;

export type DisplayModeChangedFunction = (displayMode: DisplayMode) => void;

export type ArticlesRemovedFunction = (
  removedArticleList: Article[],
) => Promise<void>;

export type ArticlesLoadedFunction = (
  sourcesArticlesMap: Map<string, number>,
) => void;

export type FocusChangedFunction = (focusTarget: FocusTarget) => void;

export interface ArticleListComponentProps {
  articlesSelected: ArticlesSelectedFunction;
  articlesRemoved: ArticlesRemovedFunction;
  articlesLoaded: ArticlesLoadedFunction;
  focusChanged: FocusChangedFunction;
  selectedSourcesList: string[];
  promisesMap: ArticlePromisesMap;
  focusedColumn: FocusTarget;
}

export type NodeEventFunction = (node: TreeNode) => void;

export interface TreeNodeComponentProps {
  node: TreeNode;
  selectedNodeUid: string;
  nested: boolean;
  nodeSelected: NodeEventFunction;
  nodeTouchStart: NodeEventFunction;
  nodeHeld: NodeEventFunction;
  nodeTouchEnd: NodeEventFunction;
  nodeMouseLeave: NodeEventFunction;
}

export type FocusTarget =
  | ".sources-column"
  | ".articles-column"
  | ".content-column";
