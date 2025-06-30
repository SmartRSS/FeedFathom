import type { SourcesDataService } from "../../db/data-services/source-data-service.ts";
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
  sourcesDataService: SourcesDataService;
};

/**
 * Register all command handlers with the command bus
 * @param dependencies The required dependencies
 */
const registerCommandHandlers = (
  dependencies: CommandRegistryDependencies,
): void => {
  const { commandBus, feedParser, sourcesDataService } = dependencies;

  // Register source command handlers
  commandBus.register(
    CommandType.ParseSource,
    createParseSourceHandler(feedParser, sourcesDataService),
  );

  // Register other command handlers here...
  // Example:
  // commandBus.register(
  //   CommandType.CREATE_SOURCE,
  //   createCreateSourceHandler(sourcesDataService)
  // );
};

export { registerCommandHandlers };
