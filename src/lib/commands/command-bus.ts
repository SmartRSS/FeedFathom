import { logError } from "../../util/log";
import { type Command, type CommandHandler, type CommandResult } from "./types";

/**
 * A command bus implementation that routes commands to their handlers
 */
export class CommandBus {
  private handlers: Map<string, CommandHandler<Command, CommandResult>> =
    new Map();

  /**
   * Clear all command handlers
   */
  public clear(): void {
    this.handlers.clear();
  }

  /**
   * Execute a command
   * @param command The command to execute
   * @returns The result of the command execution
   */
  public async execute<TCommand extends Command, TResult extends CommandResult>(
    command: TCommand,
  ): Promise<TResult> {
    const handler = this.handlers.get(command.type);

    if (!handler) {
      throw new Error(
        `No handler registered for command type: ${command.type}`,
      );
    }

    try {
      return (await handler(command)) as TResult;
    } catch (error) {
      logError(`Error executing command ${command.type}:`, error);
      throw error;
    }
  }

  /**
   * Register a command handler
   * @param commandType The type of command this handler processes
   * @param handler The handler function
   */
  public register<TCommand extends Command, TResult extends CommandResult>(
    commandType: string,
    handler: CommandHandler<TCommand, TResult>,
  ): void {
    if (this.handlers.has(commandType)) {
      throw new Error(
        `Handler for command type ${commandType} already registered`,
      );
    }

    // Since TCommand extends Command and TResult extends CommandResult,
    // this is type-safe but TypeScript needs help understanding the relationship
    const typedHandler: CommandHandler<Command, CommandResult> = async (
      command: Command,
    ) => {
      return await (handler(command as TCommand) as Promise<CommandResult>);
    };

    this.handlers.set(commandType, typedHandler);
  }
}
