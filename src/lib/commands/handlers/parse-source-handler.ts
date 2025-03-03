import { type SourcesRepository } from "$lib/db/source-repository";
import { type FeedParser } from "$lib/feed-parser";
import { logError } from "../../../util/log";
import {
  type CommandHandler,
  type ParseSourceCommand,
  type SourceCommandResult,
} from "../types";

/**
 * Handler for the parse source command
 */
export class ParseSourceHandler {
  constructor(
    private readonly feedParser: FeedParser,
    private readonly sourcesRepository: SourcesRepository,
  ) {}

  /**
   * Execute the parse source command
   * @param command The parse source command
   * @returns The result of the command execution
   */
  public async execute(
    command: ParseSourceCommand,
  ): Promise<SourceCommandResult> {
    try {
      // Get the source from the repository
      const source = await this.sourcesRepository.findSourceById(
        Number(command.sourceId),
      );

      if (!source) {
        return {
          error: new Error(`Source with ID ${command.sourceId} not found`),
          success: false,
        };
      }

      // Parse the source
      await this.feedParser.parseSource(source);

      return {
        sourceId: source.id.toString(),
        success: true,
      };
    } catch (error) {
      logError(
        `Error executing command for source ID: ${command.sourceId}`,
        error,
      );
      return {
        error: error instanceof Error ? error : new Error(String(error)),
        success: false,
      };
    }
  }
}

/**
 * Factory function to create a parse source command handler
 */
export const createParseSourceHandler = (
  feedParser: FeedParser,
  sourcesRepository: SourcesRepository,
): CommandHandler<ParseSourceCommand, SourceCommandResult> => {
  const handler = new ParseSourceHandler(feedParser, sourcesRepository);
  return async (command: ParseSourceCommand) => {
    return await handler.execute(command);
  };
};
