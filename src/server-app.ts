import { createHash } from "node:crypto";
import { Elysia, NotFound, ValidationError } from "elysia";
import { DecodeError } from "typebox/value";
import {
  type AuthRouteServices,
  createAuthRoutes,
} from "#features/auth/routes.ts";
import {
  createFeedRoutes,
  type FeedRouteServices,
} from "#features/feeds/routes.ts";
import {
  createReaderRoutes,
  type ReaderRouteServices,
} from "#features/reader/routes.ts";
import {
  type AdminRouteServices,
  createAdminRoutes,
} from "#features/admin/routes.ts";
import {
  createMailRoute,
  type MailRouteServices,
} from "#features/mail-ingest/routes/mail.ts";
import { MailRejectedError } from "#features/mail-ingest/email-handler.ts";
import {
  createInternalRoutes,
  healthcheckPath,
} from "#platform/http/internal-routes.ts";
import { turnstileOrigin } from "#shared/contracts/turnstile.ts";
import { serviceWorkerPathPattern } from "#shared/contracts/service-worker-file.ts";
import { maximumFeedBodyBytes } from "#platform/http/http-cache-store.ts";
import { HttpDeferredError } from "#platform/http/http-deferred-error.ts";
import { HttpDeadlineError } from "#platform/http/request-deadline.ts";
import { invalidRequestMessage, jsonError } from "#platform/http/json.ts";
import {
  type MailRelayRejection,
  mailRelayRejectionStatus,
} from "#shared/contracts/mail-relay.ts";

// Everything the routes reach, built once per process by the entrypoint.
export type ServerServices = AuthRouteServices &
  FeedRouteServices &
  ReaderRouteServices &
  AdminRouteServices &
  MailRouteServices;

export type ServerAppOptions = {
  spaDirectory?: string;
};

// The origin is rate limited, or this instance's own politeness interval for
// the host has not elapsed. The client is meant to come back, and
// Retry-After says when. Clamped to an hour: retryAt can come from an
// upstream Retry-After header with no sanity check of its own.
function deferredResponse(error: HttpDeferredError) {
  const retryAfterSeconds = Math.min(
    Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)),
    3_600,
  );
  return jsonError(
    `This feed's server was just checked — try again in ${retryAfterSeconds}s.`,
    429,
    { "Retry-After": retryAfterSeconds.toString() },
  );
}

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
  slowRequestMs: number,
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
  if (durationMs < slowRequestMs) return;
  console.log(`${request.method} ${routePattern} ${status} ${durationMs}`);
}

// Only scripts are restricted: feed content loads images, media, styles and
// frames from anywhere, so there is deliberately no default-src for those to
// fall back to. The shell's inline scripts are allowed by hash, and
// Turnstile's script origin only while a site key turns the captcha on.
function contentSecurityPolicy(
  shell: string,
  turnstileSiteKey: string | undefined,
): string {
  const scriptSources = ["'self'"];
  for (const [, script = ""] of shell.matchAll(/<script>([\s\S]*?)<\/script>/g))
    scriptSources.push(
      `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    );
  if (turnstileSiteKey?.trim()) scriptSources.push(turnstileOrigin);
  return `script-src ${scriptSources.join(" ")}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
}

export async function createServerApp(
  services: ServerServices,
  options: ServerAppOptions = {},
) {
  const { config } = services;
  const { production } = config;
  const spaDirectory = options.spaDirectory ?? "spa";
  const shellFile = Bun.file(`${spaDirectory}/index.html`);
  const shellHeaders = {
    "Cache-Control": "no-cache",
    ...(production && (await shellFile.exists())
      ? {
          "Content-Security-Policy": contentSecurityPolicy(
            await shellFile.text(),
            config.TURNSTILE_SITE_KEY,
          ),
        }
      : {}),
  };
  const spaRoutes = production
    ? new Elysia().get("/*", async ({ path }) => {
        // Map / to /index.html for file lookup
        const filePath = path === "/" ? "/index.html" : path;
        const file = Bun.file(`${spaDirectory}${filePath}`);
        if (!(await file.exists())) throw new NotFound();
        if (serviceWorkerPathPattern.test(filePath)) {
          return new Response(file, {
            headers: { "Cache-Control": "public, max-age=3600" },
          });
        }
        // Hashed names change whenever the content does.
        if (filePath.startsWith("/assets/")) {
          return new Response(file, {
            headers: { "Cache-Control": "public, max-age=31536000, immutable" },
          });
        }
        if (filePath === "/index.html") {
          return new Response(file, { headers: shellHeaders });
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
      return new Response(shellFile, { headers: shellHeaders });
    }
    if (error instanceof NotFound) {
      return undefined;
    }
    // Elysia's own body is a dump of its internal validation state, not the
    // error envelope clients read.
    if (error instanceof ValidationError) {
      return jsonError(invalidRequestMessage, 422);
    }
    if (error instanceof HttpDeferredError) {
      return deferredResponse(error);
    }
    // The sender's fault, not ours: the mail relay bounces it, and spam to
    // unknown addresses stays out of the error log.
    if (error instanceof MailRejectedError) {
      const rejection: MailRelayRejection = {
        error: error.message,
        rejected: true,
      };
      return Response.json(rejection, { status: mailRelayRejectionStatus });
    }
    if (error instanceof DecodeError) {
      console.error(`Decode error on ${path}:`, JSON.stringify(error.cause));
      return jsonError(invalidRequestMessage, 400);
    }
    // Our own request budget ran out. That is an upstream timeout, not a
    // malformed request, and the handlers that fetch a user-supplied URL
    // re-raise it rather than blaming the URL.
    if (error instanceof HttpDeadlineError) {
      console.error(`Deadline exceeded on ${path}`);
      return jsonError("This site isn't responding right now.", 504);
    }
    console.error(`Unhandled error on ${path}:`, error);
    return jsonError("Internal Server Error", 500);
  }

  return (
    // Bun buffers the whole body before any schema validation runs, so the
    // cap has to sit at the server level, not per-route. The largest
    // legitimate body is a pushed feed document, which can carry anything a
    // fetch could, so the cap is the fetch pipeline's.
    new Elysia({
      serve: { maxRequestBodySize: maximumFeedBodyBytes },
    })
      .onRequest(({ request }) => {
        requestStartedAt.set(request, performance.now());
      })
      .onAfterResponse(({ request, route, path, set, responseValue }) => {
        const status =
          responseValue instanceof Response
            ? responseValue.status
            : typeof set.status === "number"
              ? set.status
              : 200;
        logSlowRequest(config.SLOW_REQUEST_MS, request, route, path, status);
      })
      .onError(({ error, request, route, path }) => {
        const response = buildErrorResponse(error, request, path);
        logSlowRequest(
          config.SLOW_REQUEST_MS,
          request,
          route,
          path,
          response?.status ?? errorStatus(error) ?? 500,
        );
        return response;
      })
      // Hooks only reach routes registered after them, so the routes come last.
      .use(createInternalRoutes())
      .use(createAuthRoutes(services))
      .use(createFeedRoutes(services))
      .use(createReaderRoutes(services))
      .use(createAdminRoutes(services))
      .use(createMailRoute(services))
      .use(spaRoutes)
  );
}

// A graceful stop waits for open responses, and event streams never finish
// on their own, so the hub ends them first.
export async function stopServerApp(
  app: Awaited<ReturnType<typeof createServerApp>>,
  { articleEventHub }: Pick<ServerServices, "articleEventHub">,
) {
  articleEventHub.close();
  await app.stop();
}
