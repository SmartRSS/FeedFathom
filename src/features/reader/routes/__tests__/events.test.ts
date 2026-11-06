import { expect, test } from "bun:test";
import type { AuthedUser } from "#features/auth/session-plugin.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import {
  type ArticleEvent,
  articleEventsChannel,
} from "#features/feeds/article-events.ts";
import type { UserSourcesDataService } from "#features/feeds/user-source-data-service.ts";
import {
  ArticleEventHub,
  type ArticleEventSubscriber,
} from "#features/reader/article-event-hub.ts";
import { getEventsHandler, refreshMs } from "#features/reader/routes/events.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  appFor,
  authenticated,
  createDependencies,
  get,
  sessionUser,
} from "../../../../__tests__/server-harness.ts";

// The stream re-reads the session and the subscriptions every refreshMs
// (#1094). The schedule is handed in, so each test fires the refresh by hand
// and awaits it instead of waiting out a minute.
async function openStream(
  sessionFor: () => AuthedUser | undefined,
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
        authenticate: async () => sessionFor(),
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

// #991: one shared subscriber fans out to every stream, and each stream
// forwards only the sources its user subscribes to.
test("the event stream forwards only the user's sources and unlistens on cancel", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  let deliver: ((channel: string, message: string) => void) | undefined;
  let connections = 0;
  const subscriber: ArticleEventSubscriber = {
    disconnect: () => {},
    on: (_event, listener) => {
      deliver = listener;
    },
    subscribe: async () => 1,
  };
  const hub = new ArticleEventHub(() => {
    connections++;
    return subscriber;
  });
  let unlistened = 0;
  dependencies.articleEventHub = strictFake<ArticleEventHub>({
    close: () => hub.close(),
    listen: (listener) => {
      const off = hub.listen(listener);
      return () => {
        unlistened++;
        off();
      };
    },
  });
  dependencies.userSourcesDataService.getUserSourceIds = async (userId) =>
    userId === sessionUser.id ? [3] : [];
  const app = await appFor(dependencies);
  const open = async () => await get(app, "/api/events", { auth: true });

  const first = await open();
  const second = await open();
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("text/event-stream");
  expect(first.headers.get("cache-control")).toBe("no-cache");
  expect(first.headers.get("x-accel-buffering")).toBe("no");
  const reader = first.body!.getReader();
  const decoder = new TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value);
  expect(await next()).toContain(": connected");
  expect(connections).toBe(1);

  deliver?.("another-channel", JSON.stringify({ count: 1, sourceId: 3 }));
  deliver?.(articleEventsChannel, "not json");
  deliver?.(articleEventsChannel, JSON.stringify({ count: 2, sourceId: 4 }));
  deliver?.(articleEventsChannel, JSON.stringify({ count: 5, sourceId: 3 }));
  expect(await next()).toBe('data: {"count":5,"sourceId":3}\n\n');

  await reader.cancel();
  expect(unlistened).toBe(1);
  await second.body!.cancel();
  expect(unlistened).toBe(2);
});

test("a client gone during the source lookup leaves no listener behind", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const controller = new AbortController();
  dependencies.userSourcesDataService.getUserSourceIds = async () => {
    controller.abort();
    return [3];
  };
  let listening = 0;
  dependencies.articleEventHub = strictFake<ArticleEventHub>({
    close: () => {},
    listen: () => {
      listening++;
      return () => {
        listening--;
      };
    },
  });
  const app = await appFor(dependencies);
  await app.handle(
    new Request("http://localhost/api/events", {
      headers: { cookie: "sid=test" },
      signal: controller.signal,
    }),
  );

  expect(listening).toBe(0);
});

test("closing the hub ends open event streams", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  const hub = new ArticleEventHub(() => ({
    disconnect: () => {},
    on: () => {},
    subscribe: async () => 1,
  }));
  dependencies.articleEventHub = hub;
  const app = await appFor(dependencies);
  const response = await get(app, "/api/events", { auth: true });
  const reader = response.body!.getReader();
  await reader.read();

  hub.close();
  expect((await reader.read()).done).toBe(true);

  // A stream that registers after shutdown began ends rather than resubscribe.
  const late = await get(app, "/api/events", { auth: true });
  const lateReader = late.body!.getReader();
  await lateReader.read();
  expect((await lateReader.read()).done).toBe(true);
});
