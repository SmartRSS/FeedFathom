import { Elysia, NotFound, ValidationError } from "elysia";
import { DecodeError } from "typebox/value";
import {
  type AdminOptionsRouteDependencies,
  createAdminOptionsRoutes,
} from "./routes/admin-options.ts";
import { createInternalRoutes } from "./routes/internal.ts";
import {
  createPublicAuthRoutes,
  type PublicAuthRouteDependencies,
} from "./routes/public-auth.ts";
import {
  createReaderRoutes,
  type ReaderRouteDependencies,
} from "./routes/reader.ts";

export type ServerDependencies = Omit<
  PublicAuthRouteDependencies,
  "secureCookies"
> &
  ReaderRouteDependencies &
  AdminOptionsRouteDependencies;

export type ServerAppOptions = {
  production?: boolean;
  spaDirectory?: string;
};

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

export async function createServerApp(
  dependencies: ServerDependencies,
  options: ServerAppOptions = {},
) {
  const production = options.production ?? false;
  const spaDirectory = options.spaDirectory ?? "spa";
  const spaRoutes = production
    ? new Elysia().get("/*", async ({ path }) => {
        const file = Bun.file(`${spaDirectory}${path}`);
        if (!(await file.exists())) throw new NotFound();
        if (/^\/sw-v\d+\.js$/.test(path)) {
          return new Response(file, {
            headers: { "Cache-Control": "public, max-age=3600" },
          });
        }
        return file;
      })
    : new Elysia();

  return new Elysia()
    .use(createInternalRoutes())
    .use(
      createPublicAuthRoutes({
        ...dependencies,
        secureCookies: production,
      }),
    )
    .use(createReaderRoutes(dependencies))
    .use(createAdminOptionsRoutes(dependencies))
    .use(spaRoutes)
    .error(({ error, request }) => {
      const path = new URL(request.url).pathname;
      if (
        error instanceof NotFound &&
        production &&
        wantsSpaShellFallback(request, path)
      ) {
        return new Response(Bun.file(`${spaDirectory}/index.html`));
      }
      if (error instanceof NotFound || error instanceof ValidationError) {
        return undefined;
      }
      if (error instanceof DecodeError) {
        console.error(`Decode error on ${path}:`, JSON.stringify(error.cause));
        return Response.json({ error: "Invalid request." }, { status: 400 });
      }
      console.error(`Unhandled error on ${path}:`, error);
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    });
}
