import { expect, test } from "bun:test";
import type { AuthedUser } from "#features/auth/session-plugin.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { ArticleEvent } from "#features/feeds/article-events.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import type { ArticleEventHub } from "#features/reader/article-event-hub.ts";
import { getEventsHandler, refreshMs } from "#features/reader/routes/events.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";

// The stream re-reads the session and the subscriptions every refreshMs
// (#1094). The schedule is handed in, so each test fires the refresh by hand
// and awaits it instead of waiting out a minute.
async function openStream(
  sessionUser: () => AuthedUser | undefined,
  sourceIds: () => number[],
) {
  const user = strictFake<AuthedUser>({ id: 7 });
  let listener: { onEvent: (event: ArticleEvent) => void } | undefined;
  const state = { stopped: [] as number[], unlistened: false };
  const ticks = new Map<number, () => Promise<void> | void>();
  const response = await getEventsHandler(
    {
      request: new Request("http://x/api/events"),
      server: null,
      sid: "s",
      user,
    },
    {
      articleEventHub: strictFake<ArticleEventHub>({
        listen: (l) => {
          listener = l;
          return () => {
            state.unlistened = true;
          };
        },
      }),
      userSourcesDataService: strictFake<UserSourcesDataService>({
        getUserSourceIds: async () => sourceIds(),
      }),
      usersDataService: strictFake<UsersDataService>({
        getUserBySid: async () => sessionUser(),
      }),
    },
    (ms, tick) => {
      ticks.set(ms, tick);
      return () => state.stopped.push(ms);
    },
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => {
    const { done, value } = await reader.read();
    return done ? null : decoder.decode(value);
  };
  expect(await next()).toBe("retry: 10000\n: connected\n\n");
  return {
    emit: (event: ArticleEvent) => listener!.onEvent(event),
    next,
    refresh: async () => await ticks.get(refreshMs)!(),
    state,
  };
}

test("a stream whose sid stops resolving ends on the next refresh", async () => {
  let session: AuthedUser | undefined = strictFake<AuthedUser>({ id: 7 });
  const stream = await openStream(
    () => session,
    () => [1],
  );
  session = undefined;
  await stream.refresh();
  expect(await stream.next()).toBeNull();
  expect(stream.state.unlistened).toBe(true);
  expect(stream.state.stopped).toHaveLength(2);
});

test("a stream whose session still resolves stays open and picks up new source ids", async () => {
  let ids = [1];
  const stream = await openStream(
    () => strictFake<AuthedUser>({ id: 7 }),
    () => ids,
  );
  ids = [1, 2];
  // Not yet subscribed as far as the stream knows, so this one is dropped.
  stream.emit({ count: 1, sourceId: 2 });
  await stream.refresh();
  stream.emit({ count: 3, sourceId: 2 });
  expect(await stream.next()).toBe('data: {"count":3,"sourceId":2}\n\n');
  expect(stream.state.unlistened).toBe(false);
  expect(stream.state.stopped).toEqual([]);
});
