import { type CommandBus } from "./command-bus";
import { createParseSourceHandler } from "./handlers/parse-source-handler";
import { CommandType } from "./types";
import { type SourcesRepository } from "../db/source-repository";
import { type FeedParser } from "../feed-parser";

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
    CommandType.PARSE_SOURCE,
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
