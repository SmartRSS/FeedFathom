import { createRequestHandler } from "$lib/create-request-handler";
import type { RequestHandler } from "@sveltejs/kit";
import { subscribeHandler } from "./handler.ts";
import { SubscribeRequest } from "./validator.ts";

export const POST: RequestHandler = createRequestHandler(
  SubscribeRequest,
  subscribeHandler,
);
