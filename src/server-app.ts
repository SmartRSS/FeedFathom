import { Elysia, NotFound, ValidationError } from "elysia";
import { DecodeError } from "typebox/value";
import { createPublicAuthRoutes } from "#features/auth/routes.ts";
import { createWebSubRoutes } from "#features/feeds/routes/websub.ts";
import { createReaderRoutes } from "#features/reader/routes.ts";
import { createAdminOptionsRoutes } from "#features/admin/routes.ts";
import { createMailRoute } from "#features/mail-ingest/routes/mail.ts";
import { config } from "#platform/config.ts";
import {
  createInternalRoutes,
  healthcheckPath,
} from "#platform/http/internal-routes.ts";
import { deferredResponse } from "#platform/http/deferred-response.ts";
import { isHttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { isHttpDeadlineError } from "#platform/http/request-deadline.ts";

export type ServerAppOptions = {
  production?: boolean;
  spaDirectory?: string;
};

// Bun buffers the whole body before any schema validation runs, so the cap
// has to sit at the server level, not per-route. The largest legitimate body
// is a pushed feed document, which the fetch pipeline caps at 24 MiB
// (http-client's maximumBodyBytes) -- the server cap must not sit below
// that or valid WebSub pushes get rejected before their own cap runs.
// Anything larger than this never reaches a handler.
export const MAX_REQUEST_BODY_BYTES = 24 * 1024 * 1024;

// A 404 for a browser navigation (not an API call, not a static asset) means
// the SolidJS router should handle the path client-side, so serve the SPA
// shell instead of a bare 404.
function wantsSpaShellFallback(request: Request, path: string): boolean {
  return (
    request.method === "GET" &&
    (request.headers.get("accept")?.includes("text/html") ?? false) &&
    path !== "/api" &&
    !path.startsWith("/api/") &&
    !path.startsWith("/assets/") &&
    !path.split("/").at(-1)?.includes(".")
  );
}

// Keyed by the Request object rather than threaded through context, since
// the `request` hook runs before routing (on a lighter context than the one
// `afterResponse`/`error` receive) and a WeakMap needs no cleanup once the
// response is logged or the request is dropped.
const requestStartedAt = new WeakMap<Request, number>();

// Elysia's own error classes (NotFound, ValidationError, ...) carry their
// HTTP status on the instance; this reads it back without a per-class import.
function errorStatus(error: unknown): number | undefined {
  return error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

// One line per request that ran past the threshold -- fast requests log
// nothing, so this stays useful signal instead of access-log noise. The
// route pattern (e.g. `/api/favicon/:id`), never the raw path with its query
// string, so the log can't leak article URLs or search terms.
function logSlowRequest(
  request: Request,
  route: string | undefined,
  path: string,
  status: number,
): void {
  const startedAt = requestStartedAt.get(request);
  if (startedAt === undefined) return;
  requestStartedAt.delete(request);
  const routePattern = route ?? path;
  if (routePattern === healthcheckPath) return;
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs < config.SLOW_REQUEST_MS) return;
  console.log(`${request.method} ${routePattern} ${status} ${durationMs}`);
}

export async function createServerApp(options: ServerAppOptions = {}) {
  const production = options.production ?? false;
  const spaDirectory = options.spaDirectory ?? "spa";
  const spaRoutes = production
    ? new Elysia().get("/*", async ({ path }) => {
        const file = Bun.file(`${spaDirectory}${path}`);
        if (!(await file.exists())) throw new NotFound();
        if (/^\/sw-[a-f0-9]+\.js$/.test(path)) {
          return new Response(file, {
            headers: { "Cache-Control": "public, max-age=3600" },
          });
        }
        return file;
      })
    : new Elysia();

  function buildErrorResponse(
    error: unknown,
    request: Request,
    path: string,
  ): Response | undefined {
    if (
      error instanceof NotFound &&
      production &&
      wantsSpaShellFallback(request, path)
    ) {
      return new Response(Bun.file(`${spaDirectory}/index.html`));
    }
    if (error instanceof NotFound) {
      return undefined;
    }
    if (error instanceof ValidationError) {
      // Elysia's own default body (a raw {type, detail, ...} dump of
      // internal validation state) doesn't match anything the client's
      // api() helper knows how to read, so every validation failure --
      // not just one endpoint's -- surfaced as "malformed error payload".
      return Response.json(
        { error: error.message || "Invalid request." },
        { status: 422 },
      );
    }
    // Deferral is not a failure: the origin is rate limited, or this
    // instance's own politeness interval for the host has not elapsed. The
    // client is meant to come back, and deferredResponse says when.
    if (isHttpDeferredError(error)) {
      return deferredResponse(error);
    }
    if (error instanceof DecodeError) {
      console.error(`Decode error on ${path}:`, JSON.stringify(error.cause));
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    // Our own 30 second budget ran out. That is an upstream timeout, not a
    // malformed request, and the handlers that fetch a user-supplied URL
    // re-raise it rather than blaming the URL.
    if (isHttpDeadlineError(error)) {
      console.error(`Deadline exceeded on ${path}`);
      return Response.json(
        { error: "Upstream request timed out." },
        { status: 504 },
      );
    }
    console.error(`Unhandled error on ${path}:`, error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }

  return new Elysia({
    serve: { maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
  })
    .request(({ request }) => {
      requestStartedAt.set(request, performance.now());
    })
    .use(createInternalRoutes())
    .use(createPublicAuthRoutes(production))
    .use(createReaderRoutes())
    .use(createAdminOptionsRoutes())
    .use(createWebSubRoutes())
    .use(createMailRoute())
    .use(spaRoutes)
    .afterResponse(({ request, route, path, set, responseValue }) => {
      const status =
        responseValue instanceof Response
          ? responseValue.status
          : typeof set.status === "number"
            ? set.status
            : 200;
      logSlowRequest(request, route, path, status);
    })
    .error(({ error, request, route, path }) => {
      const response = buildErrorResponse(error, request, path);
      logSlowRequest(
        request,
        route,
        path,
        response?.status ?? errorStatus(error) ?? 500,
      );
      return response;
    });
}
