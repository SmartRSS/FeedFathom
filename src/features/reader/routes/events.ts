import type { Server } from "bun";
import { type AuthedUser, userFor } from "#features/auth/session-plugin.ts";
import type * as auth from "#features/auth/services.ts";
import type * as feeds from "#features/feeds/services.ts";
import type * as reader from "#features/reader/services.ts";

// Under the 100 s Cloudflare and 60 s nginx idle cuts, so a quiet stream
// stays open between article events.
const heartbeatMs = 25_000;
// ponytail: subscriptions and the session are re-read on this interval, so
// a new subscription's events or a revoked session take up to a minute to
// apply here. Push a per-user invalidation through the hub if that matters.
export const refreshMs = 60_000;

// Runs `tick` every `ms` until the returned stop is called. A test passes its
// own to fire the ticks by hand and await each one.
type Every = (ms: number, tick: () => Promise<void> | void) => () => void;
const every: Every = (ms, tick) => {
  const id = setInterval(() => void tick(), ms);
  return () => clearInterval(id);
};

/**
 * GET /api/events (#991): a Server-Sent Events stream of article events for
 * the sources this user subscribes to. A signal only -- the dashboard answers
 * it by reloading the tree it would otherwise poll for.
 */
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
  // Bun closes a connection idle for 10 s by default; this one is meant to be.
  server?.timeout(request, 0);
  const encoder = new TextEncoder();
  let stop: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => stop?.(),
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const end = () => {
        if (closed) return;
        stop?.();
        controller.close();
      };
      const unlisten = articleEventHub.listen({
        onClose: end,
        onEvent: (event) => {
          if (sourceIds.has(event.sourceId))
            send(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
      const stopHeartbeat = schedule(heartbeatMs, () =>
        send(": heartbeat\n\n"),
      );
      const stopRefresh = schedule(refreshMs, async () => {
        try {
          const current = await userFor(sid, services);
          if (closed) return;
          if (current?.id !== user.id) {
            // The reconnect meets the session check and stops there.
            end();
            return;
          }
          const ids = await userSourcesDataService.getUserSourceIds(user.id);
          sourceIds = new Set(ids);
        } catch (error) {
          console.error("Refreshing an event stream failed:", error);
        }
      });
      stop = () => {
        if (closed) return;
        closed = true;
        unlisten();
        stopHeartbeat();
        stopRefresh();
      };
      // An abort during the source lookup above fired before this listener.
      if (request.signal.aborted) {
        end();
        return;
      }
      request.signal.addEventListener("abort", () => stop?.(), {
        once: true,
      });
      // The comment line gets the headers out at once, so EventSource sees
      // the stream open rather than waiting on the first article.
      send("retry: 10000\n: connected\n\n");
    },
  });
  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
