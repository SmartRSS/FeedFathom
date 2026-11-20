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

export type ServerServices = AuthRouteServices &
  FeedRouteServices &
  ReaderRouteServices &
  AdminRouteServices &
  MailRouteServices;

export type ServerAppOptions = {
  spaDirectory?: string;
};

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

const requestStartedAt = new WeakMap<Request, number>();

function errorStatus(error: unknown): number | undefined {
  return error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

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

function contentSecurityPolicy(
  shell: string,
  turnstileSiteKey: string | undefined,
): string {
  const scriptSources = ["'self'"];
  for (const [, script = ""] of shell.matchAll(/<script>([\s\S]*?)<\/script>/g))
    scriptSources.push(
      `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    );
  if (turnstileSiteKey !== undefined) scriptSources.push(turnstileOrigin);
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
        const filePath = path === "/" ? "/index.html" : path;
        const file = Bun.file(`${spaDirectory}${filePath}`);
        if (!(await file.exists())) throw new NotFound();
        if (serviceWorkerPathPattern.test(filePath)) {
          return new Response(file, {
            headers: { "Cache-Control": "public, max-age=3600" },
          });
        }
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
    if (error instanceof ValidationError) {
      return jsonError(invalidRequestMessage, 422);
    }
    if (error instanceof HttpDeferredError) {
      return deferredResponse(error);
    }
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
    if (error instanceof HttpDeadlineError) {
      console.error(`Deadline exceeded on ${path}`);
      return jsonError("This site isn't responding right now.", 504);
    }
    console.error(`Unhandled error on ${path}:`, error);
    return jsonError("Internal Server Error", 500);
  }

  return new Elysia({
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
    .use(createInternalRoutes())
    .use(createAuthRoutes(services))
    .use(createFeedRoutes(services))
    .use(createReaderRoutes(services))
    .use(createAdminRoutes(services))
    .use(createMailRoute(services))
    .use(spaRoutes);
}

export async function stopServerApp(
  app: Awaited<ReturnType<typeof createServerApp>>,
  { articleEventHub }: Pick<ServerServices, "articleEventHub">,
) {
  articleEventHub.close();
  await app.stop();
}
