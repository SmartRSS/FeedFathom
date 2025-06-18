import type { SourcesRepository } from "../db/source-repository.ts";
import type { FeedParser } from "../feed-parser.ts";
import type { CommandBus } from "./command-bus.ts";
import { createParseSourceHandler } from "./handlers/parse-source-handler.ts";
import { CommandType } from "./types.ts";

/**
 * Dependencies required for command registration
 */
export type CommandRegistryDependencies = {
  commandBus: CommandBus;
  feedParser: FeedParser;
  sourcesRepository: SourcesRepository;
};

/**
 * Register all command handlers with the command bus
 * @param dependencies The required dependencies
 */
const registerCommandHandlers = (
  dependencies: CommandRegistryDependencies,
): void => {
  const { commandBus, feedParser, sourcesRepository } = dependencies;

  // Register source command handlers
  commandBus.register(
    CommandType.ParseSource,
    createParseSourceHandler(feedParser, sourcesRepository),
  );

  // Register other command handlers here...
  // Example:
  // commandBus.register(
  //   CommandType.CREATE_SOURCE,
  //   createCreateSourceHandler(sourcesRepository)
  // );
};

export { registerCommandHandlers };
