import type { Server } from "bun";
import { type AuthedUser, userFor } from "#features/auth/session-plugin.ts";
import type * as auth from "#features/auth/services.ts";
import type * as feeds from "#features/feeds/services.ts";
import type * as reader from "#features/reader/services.ts";

const heartbeatMs = 25_000;
const encoder = new TextEncoder();
const heartbeatChunk = encoder.encode(": heartbeat\n\n");
const connectedChunk = encoder.encode("retry: 10000\n: connected\n\n");

type Every = (ms: number, tick: () => Promise<void> | void) => () => void;
const every: Every = (ms, tick) => {
  const id = setInterval(() => void tick(), ms);
  return () => clearInterval(id);
};

export async function getEventsHandler(
  {
    request,
    server,
    sid,
    user,
  }: {
    request: Request;
    server: null | Pick<Server<unknown>, "timeout">;
    sid: string;
    user: AuthedUser;
  },
  services: Pick<typeof auth, "usersDataService"> &
    Pick<typeof feeds, "userSourcesDataService"> &
    Pick<typeof reader, "articleEventHub">,
  schedule = every,
) {
  const { articleEventHub, userSourcesDataService } = services;
  let sourceIds = new Set(
    await userSourcesDataService.getUserSourceIds(user.id),
  );
  server?.timeout(request, 0);
  let stop: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => stop?.(),
    start(controller) {
      let closed = false;
      let refreshing = false;
      let pendingRefresh = false;
      const sendBytes = (chunk: Uint8Array) => {
        if (!closed) controller.enqueue(chunk);
      };
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const end = () => {
        if (closed) return;
        stop?.();
        controller.close();
      };
      const refresh = async () => {
        if (closed) return;
        if (refreshing) {
          pendingRefresh = true;
          return;
        }
        refreshing = true;
        try {
          do {
            pendingRefresh = false;
            // oxlint-disable-next-line no-await-in-loop
            const current = await userFor(sid, services);
            if (closed) return;
            if (current?.id !== user.id) {
              end();
              return;
            }
            // oxlint-disable-next-line no-await-in-loop
            const ids = await userSourcesDataService.getUserSourceIds(user.id);
            if (closed) return;
            sourceIds = new Set(ids);
          } while (pendingRefresh);
        } catch (error) {
          console.error("Refreshing an event stream failed:", error);
        } finally {
          refreshing = false;
        }
      };
      const unlisten = articleEventHub.listen({
        onClose: end,
        onEvent: (event) => {
          if (sourceIds.has(event.sourceId))
            send(`data: ${JSON.stringify(event)}\n\n`);
        },
        onUserInvalidated: (userId) => {
          if (userId === user.id) void refresh();
        },
      });
      const stopHeartbeat = schedule(heartbeatMs, () =>
        sendBytes(heartbeatChunk),
      );
      stop = () => {
        if (closed) return;
        closed = true;
        unlisten();
        stopHeartbeat();
      };
      if (request.signal.aborted) {
        end();
        return;
      }
      request.signal.addEventListener("abort", end, { once: true });
      sendBytes(connectedChunk);
    },
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}
