import type { Server } from "bun";
import { type AuthedUser, userFor } from "#features/auth/session-plugin.ts";
import type * as auth from "#features/auth/services.ts";
import type * as feeds from "#features/feeds/services.ts";
import type * as reader from "#features/reader/services.ts";

const heartbeatMs = 25_000;
export const refreshMs = 60_000;

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
      if (request.signal.aborted) {
        end();
        return;
      }
      request.signal.addEventListener("abort", () => stop?.(), {
        once: true,
      });
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
