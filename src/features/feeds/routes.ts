import { Elysia } from "elysia";
import {
  findQuery,
  newsletterAddressRequest,
  previewQuery,
  refreshSourceRequest,
  subscribeRequest,
} from "#shared/contracts/requests.ts";
import { createAuthPlugin } from "#features/auth/session-plugin.ts";
import { getFaviconHandler } from "#features/feeds/routes/favicon.ts";
import { getFindHandler } from "#features/feeds/routes/find.ts";
import { postNewsletterAddressHandler } from "#features/feeds/routes/newsletter-address.ts";
import {
  getOpmlHandler,
  opmlRequest,
  postOpmlHandler,
} from "#features/feeds/routes/opml.ts";
import { getPreviewHandler } from "#features/feeds/routes/preview.ts";
import { postRefreshSourceHandler } from "#features/feeds/routes/refresh.ts";
import { postSubscribeHandler } from "#features/feeds/routes/subscribe.ts";
import {
  createWebSubRoutes,
  type WebSubRouteServices,
} from "#features/feeds/routes/websub.ts";

// Whatever the handlers below declare they need, so the group asks for no
// more than its routes use.
export type FeedRouteServices = Parameters<typeof createAuthPlugin>[0] &
  Parameters<typeof getFaviconHandler>[1] &
  Parameters<typeof getFindHandler>[1] &
  Parameters<typeof getOpmlHandler>[1] &
  Parameters<typeof getPreviewHandler>[1] &
  Parameters<typeof postNewsletterAddressHandler>[1] &
  Parameters<typeof postOpmlHandler>[1] &
  Parameters<typeof postRefreshSourceHandler>[1] &
  Parameters<typeof postSubscribeHandler>[1] &
  WebSubRouteServices;

const signedInRoutes = (services: FeedRouteServices) =>
  new Elysia()
    .use(createAuthPlugin(services))
    .get("/api/favicon/:id", (ctx) => getFaviconHandler(ctx, services))
    .get("/api/find", { query: findQuery }, (ctx) =>
      getFindHandler(ctx, services),
    )
    .get("/api/preview", { query: previewQuery }, (ctx) =>
      getPreviewHandler(ctx, services),
    )
    .post("/api/subscribe", { body: subscribeRequest }, (ctx) =>
      postSubscribeHandler(ctx, services),
    )
    .post(
      "/api/newsletter-address",
      { body: newsletterAddressRequest },
      (ctx) => postNewsletterAddressHandler(ctx, services),
    )
    .post("/api/source/refresh", { body: refreshSourceRequest }, (ctx) =>
      postRefreshSourceHandler(ctx, services),
    )
    .post("/api/options/opml", { body: opmlRequest }, (ctx) =>
      postOpmlHandler(ctx, services),
    )
    .get("/api/options/opml", (ctx) => getOpmlHandler(ctx, services));

// The WebSub callback is the hub's, not a reader's, so it sits outside the
// session check.
export const createFeedRoutes = (services: FeedRouteServices) =>
  new Elysia().use(createWebSubRoutes(services)).use(signedInRoutes(services));
