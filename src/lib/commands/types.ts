/**
 * Command types enum
 */
export enum CommandType {
  BatchUpsertArticles = "article.batch_upsert",
  Cleanup = "system.cleanup",
  CreateArticle = "article.create",
  CreateFolder = "folder.create",
  CreateSource = "source.create",
  CreateUser = "user.create",
  DeleteArticle = "article.delete",
  DeleteFolder = "folder.delete",
  DeleteSource = "source.delete",
  DeleteUser = "user.delete",
  MakeUserAdmin = "user.make_admin",
  ParseSource = "source.parse",
  RefreshSourceFavicon = "source.refresh_favicon",
  UpdateArticle = "article.update",
  UpdateFolder = "folder.update",
  UpdateSource = "source.update",
  UpdateUser = "user.update",
}

export type ArticleCommandResult = CommandResult & {
  articleId?: string;
  articleIds?: string[];
};

export type BatchUpsertArticlesCommand = Command & {
  articles: Array<{
    content: string;
    publishedAt?: Date;
    sourceId: string;
    title: string;
    url?: string;
  }>;
  type: CommandType.BatchUpsertArticles;
};

/**
 * System command interfaces
 */
export type CleanupCommand = Command & {
  type: CommandType.Cleanup;
};

/**
 * Base command interface
 */
export type Command = {
  timestamp?: number;
  type: string;
};

/**
 * Command handler function type
 */
export type CommandHandler<
  TCommand extends Command,
  TResult extends CommandResult,
> = (command: TCommand) => Promise<TResult>;

/**
 * Base command result interface
 */
export type CommandResult = {
  error?: Error;
  success: boolean;
};

/**
 * Article command interfaces
 */
export type CreateArticleCommand = Command & {
  content: string;
  publishedAt?: Date;
  sourceId: string;
  title: string;
  type: CommandType.CreateArticle;
  url?: string;
};

/**
 * Folder command interfaces
 */
export type CreateFolderCommand = Command & {
  name: string;
  type: CommandType.CreateFolder;
  userId: string;
};

/**
 * Source command interfaces
 */
export type CreateSourceCommand = Command & {
  title?: string;
  type: CommandType.CreateSource;
  url: string;
};

/**
 * User command interfaces
 */
export type CreateUserCommand = Command & {
  email: string;
  password: string;
  type: CommandType.CreateUser;
};

export type DeleteArticleCommand = Command & {
  articleId: string;
  type: CommandType.DeleteArticle;
};

export type DeleteFolderCommand = Command & {
  folderId: string;
  type: CommandType.DeleteFolder;
};

export type DeleteSourceCommand = Command & {
  sourceId: string;
  type: CommandType.DeleteSource;
};

export type DeleteUserCommand = Command & {
  type: CommandType.DeleteUser;
  userId: string;
};

export type FolderCommandResult = CommandResult & {
  folderId?: string;
};

export type MakeUserAdminCommand = Command & {
  email: string;
  type: CommandType.MakeUserAdmin;
};

export type ParseSourceCommand = Command & {
  sourceId: string;
  type: CommandType.ParseSource;
};

export type RefreshSourceFaviconCommand = Command & {
  homeUrl: string;
  sourceId: string;
  type: CommandType.RefreshSourceFavicon;
};

/**
 * Command result interfaces
 */
export type SourceCommandResult = CommandResult & {
  sourceId?: string;
};

export type SystemCommandResult = CommandResult & {
  message?: string;
};

export type UpdateArticleCommand = Command & {
  articleId: string;
  content?: string;
  publishedAt?: Date;
  title?: string;
  type: CommandType.UpdateArticle;
  url?: string;
};

export type UpdateFolderCommand = Command & {
  folderId: string;
  name?: string;
  type: CommandType.UpdateFolder;
};

export type UpdateSourceCommand = Command & {
  sourceId: string;
  title?: string;
  type: CommandType.UpdateSource;
  url?: string;
};

export type UpdateUserCommand = Command & {
  email?: string;
  password?: string;
  type: CommandType.UpdateUser;
  userId: string;
};

export type UserCommandResult = CommandResult & {
  userId?: string;
};
