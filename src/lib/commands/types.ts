/**
 * Command types enum
 */
export enum CommandType {
  // biome-ignore lint/style/useNamingConvention: <explanation>
  BATCH_UPSERT_ARTICLES = "article.batch_upsert",
  // System commands
  // biome-ignore lint/style/useNamingConvention: <explanation>
  CLEANUP = "system.cleanup",
  // Article commands
  // biome-ignore lint/style/useNamingConvention: <explanation>
  CREATE_ARTICLE = "article.create",
  // Folder commands
  // biome-ignore lint/style/useNamingConvention: <explanation>
  CREATE_FOLDER = "folder.create",
  // Source commands
  // biome-ignore lint/style/useNamingConvention: <explanation>
  CREATE_SOURCE = "source.create",

  // User commands
  // biome-ignore lint/style/useNamingConvention: <explanation>
  CREATE_USER = "user.create",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  DELETE_ARTICLE = "article.delete",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  DELETE_FOLDER = "folder.delete",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  DELETE_SOURCE = "source.delete",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  DELETE_USER = "user.delete",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  MAKE_USER_ADMIN = "user.make_admin",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  PARSE_SOURCE = "source.parse",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  REFRESH_SOURCE_FAVICON = "source.refresh_favicon",

  // biome-ignore lint/style/useNamingConvention: <explanation>
  UPDATE_ARTICLE = "article.update",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  UPDATE_FOLDER = "folder.update",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  UPDATE_SOURCE = "source.update",
  // biome-ignore lint/style/useNamingConvention: <explanation>
  UPDATE_USER = "user.update",
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
  type: CommandType.BATCH_UPSERT_ARTICLES;
};

/**
 * System command interfaces
 */
export type CleanupCommand = Command & {
  type: CommandType.CLEANUP;
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
  type: CommandType.CREATE_ARTICLE;
  url?: string;
};

/**
 * Folder command interfaces
 */
export type CreateFolderCommand = Command & {
  name: string;
  type: CommandType.CREATE_FOLDER;
  userId: string;
};

/**
 * Source command interfaces
 */
export type CreateSourceCommand = Command & {
  title?: string;
  type: CommandType.CREATE_SOURCE;
  url: string;
};

/**
 * User command interfaces
 */
export type CreateUserCommand = Command & {
  email: string;
  password: string;
  type: CommandType.CREATE_USER;
};

export type DeleteArticleCommand = Command & {
  articleId: string;
  type: CommandType.DELETE_ARTICLE;
};

export type DeleteFolderCommand = Command & {
  folderId: string;
  type: CommandType.DELETE_FOLDER;
};

export type DeleteSourceCommand = Command & {
  sourceId: string;
  type: CommandType.DELETE_SOURCE;
};

export type DeleteUserCommand = Command & {
  type: CommandType.DELETE_USER;
  userId: string;
};

export type FolderCommandResult = CommandResult & {
  folderId?: string;
};

export type MakeUserAdminCommand = Command & {
  email: string;
  type: CommandType.MAKE_USER_ADMIN;
};

export type ParseSourceCommand = Command & {
  sourceId: string;
  type: CommandType.PARSE_SOURCE;
};

export type RefreshSourceFaviconCommand = Command & {
  homeUrl: string;
  sourceId: string;
  type: CommandType.REFRESH_SOURCE_FAVICON;
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
  type: CommandType.UPDATE_ARTICLE;
  url?: string;
};

export type UpdateFolderCommand = Command & {
  folderId: string;
  name?: string;
  type: CommandType.UPDATE_FOLDER;
};

export type UpdateSourceCommand = Command & {
  sourceId: string;
  title?: string;
  type: CommandType.UPDATE_SOURCE;
  url?: string;
};

export type UpdateUserCommand = Command & {
  email?: string;
  password?: string;
  type: CommandType.UPDATE_USER;
  userId: string;
};

export type UserCommandResult = CommandResult & {
  userId?: string;
};
