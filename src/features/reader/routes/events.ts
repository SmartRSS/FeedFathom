import type { Server } from "bun";
import { type AuthedUser, userFor } from "#features/auth/session-plugin.ts";
import { userSourcesDataService } from "#features/feeds/services.ts";
import { articleEventHub } from "#features/reader/services.ts";

// Under the 100 s Cloudflare and 60 s nginx idle cuts, so a quiet stream
// stays open between article events.
const heartbeatMs = 25_000;
// ponytail: subscriptions and the session are re-read on this interval, so
// a new subscription's events or a revoked session take up to a minute to
// apply here. Push a per-user invalidation through the hub if that matters.
const refreshMs = 60_000;

/**
 * GET /api/events (#991): a Server-Sent Events stream of article events for
 * the sources this user subscribes to. A signal only -- the dashboard answers
 * it by reloading the tree it would otherwise poll for.
 */
export async function getEventsHandler({
  cookie,
  request,
  server,
  user,
}: {
  cookie: { sid?: { value?: unknown } };
  request: Request;
  server: null | Pick<Server<unknown>, "timeout">;
  user: AuthedUser;
}) {
  let sourceIds = new Set(
    await userSourcesDataService.getUserSourceIds(user.id),
  );
  const sid = cookie.sid?.value;
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
      const heartbeat = setInterval(() => send(": heartbeat\n\n"), heartbeatMs);
      const refresh = setInterval(() => {
        void (async () => {
          try {
            const current = await userFor(sid);
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
        })();
      }, refreshMs);
      stop = () => {
        if (closed) return;
        closed = true;
        unlisten();
        clearInterval(heartbeat);
        clearInterval(refresh);
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
