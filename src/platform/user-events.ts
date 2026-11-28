import type { RedisClient } from "bun";

export const userEventsChannel = "feedfathom:user-events";

export type UserEvent = { userId: number };

export function parseUserEvent(message: string): UserEvent | undefined {
  try {
    const value: unknown = JSON.parse(message);
    if (
      typeof value === "object" &&
      value !== null &&
      "userId" in value &&
      Number.isSafeInteger(value.userId)
    ) {
      return { userId: Number(value.userId) };
    }
  } catch {}
  return undefined;
}

export class UserEventPublisher {
  constructor(private readonly redis: Pick<RedisClient, "publish">) {}

  public publish(userId: number): void {
    this.redis
      .publish(
        userEventsChannel,
        JSON.stringify({ userId } satisfies UserEvent),
      )
      .catch((error: unknown) => {
        console.error("Publishing a user event failed:", error);
      });
  }
}
